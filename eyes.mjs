// Her eyes: a strict read-only allowlist for Bash on the main thread. Anything not
// positively recognised is refused.

const SAFE_PIPE = new Set(['head', 'tail', 'wc', 'grep', 'rg', 'sort', 'uniq', 'cut', 'jq', 'sed']);
const BANNED_WORDS = new Set(['tee', 'xargs', 'sudo', 'rm', 'mv', 'cp', 'kill']);
const PLAIN = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'stat', 'file', 'du', 'df', 'pwd', 'which']);

const OPERATOR_WHY = {
  ';': 'chained with ";" — run each as its own call',
  '&': 'background or "&" — run each as its own call (only && between two read-only commands is allowed)',
  '||': '"||" is not allowed — run each as its own call',
  '>': 'redirects are not allowed (only 2>/dev/null) — use the Read tool, or pipe into head/tail',
  '<': 'redirects are not allowed — use the Read tool, or pipe into head/tail',
  '`': 'command substitution is not allowed — run the inner command as its own call and use its result',
  '(': 'subshells and substitution are not allowed — run each command as its own call',
  ')': 'subshells and substitution are not allowed — run each command as its own call',
  '\n': 'one command per call — run each as its own call (or join two read-only commands with &&)',
  '\r': 'one command per call — run each as its own call',
};

/** Quote-aware split into `&&`-separated pipelines of pipe-separated segments of words; throws a reason on any other shell operator. */
function parse(cmd) {
  const pipes = [[[]]];
  let word = '';
  let has = false;
  let q = null;
  const segs = () => pipes[pipes.length - 1];
  const endWord = () => { if (has) segs()[segs().length - 1].push(word); word = ''; has = false; };
  const boundary = (i) => i >= cmd.length || /[\s|&]/.test(cmd[i]);
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    const n = cmd[i + 1];
    if (q === "'") { if (c === "'") q = null; else word += c; continue; }
    if (q === '"') {
      if (c === '"') q = null;
      else if (c === '`' || (c === '$' && (n === '(' || n === '{'))) throw new Error(OPERATOR_WHY['`']);
      else if (c === '\\' && n !== undefined) { word += n; i++; }
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; has = true; continue; }
    if (c === '\\') { if (n === undefined) throw new Error('trailing backslash'); word += n; has = true; i++; continue; }
    if (c === ' ' || c === '\t') { endWord(); continue; }
    // stderr to nowhere / merged into stdout is harmless
    if (c === '2' && !has && cmd.startsWith('2>/dev/null', i) && boundary(i + 11)) { i += 10; continue; }
    if (c === '2' && !has && cmd.startsWith('2>&1', i) && boundary(i + 4)) { i += 3; continue; }
    if (c === '|') {
      if (n === '|') throw new Error(OPERATOR_WHY['||']);
      endWord(); segs().push([]); continue;
    }
    if (c === '&') {
      if (n !== '&') throw new Error(OPERATOR_WHY['&']);
      endWord(); pipes.push([[]]); i++; continue;
    }
    if (c === '$' && n && /[\w({]/.test(n)) throw new Error('shell expansion ($) is not allowed — write the literal value');
    if (';<>`\n\r()'.includes(c)) throw new Error(OPERATOR_WHY[c]);
    word += c; has = true;
  }
  if (q) throw new Error('unterminated quote');
  endWord();
  return pipes;
}

const has = (args, ...flags) => args.some((a) => flags.some((f) => a === f || (f.length > 2 && f.startsWith('--') && a.startsWith(f + '='))));


// sed is a reader only as `sed -n` with print-only scripts (1,20p  /re/p  $p). No -i, no script files, no w/e/r commands.
const SED_ADDR = String.raw`(?:\d+|\$|\/(?:[^\/\\]|\\.)*\/)`;
const SED_CMD = String.raw`(?:${SED_ADDR}(?:,${SED_ADDR})?)?p`;
const SED_SCRIPT = new RegExp(String.raw`^\s*${SED_CMD}\s*(?:;\s*${SED_CMD}\s*)*$`);
function sedReadOnly(s) {
  const args = s.slice(1);
  let quiet = false;
  const scripts = [];
  for (let i = 0; i < args.length; i++) {
    const x = args[i];
    if (x === '-n' || x === '--quiet' || x === '--silent') { quiet = true; continue; }
    if (x === '-E' || x === '-r' || x === '--regexp-extended') continue;
    if (x === '-e' || x === '--expression') { scripts.push(args[++i] ?? ''); continue; }
    if (x.startsWith('--expression=')) { scripts.push(x.slice(13)); continue; }
    if (/^-[a-zA-Z]*i/.test(x) || x.startsWith('--in-place') || x === '-f' || x.startsWith('--file') || /^-[a-zA-Z]*[fs]/.test(x)) return false;
    if (x.startsWith('-') && x.length > 1) return false;
    if (!scripts.length) scripts.push(x); // first plain word is the script when no -e was used
  }
  return quiet && scripts.length > 0 && scripts.every((sc) => SED_SCRIPT.test(sc));
}

function gitOk(args) {
  let a = [...args];
  while (a.length && a[0].startsWith('-')) {
    if (a[0] === '-C' && a.length > 1) { a = a.slice(2); continue; }
    return false; // -c, --exec-path, … change behaviour
  }
  const sub = a[0];
  const rest = a.slice(1);
  if (['log', 'show', 'diff', 'status', 'rev-parse', 'ls-remote', 'ls-files', 'blame'].includes(sub)) {
    return !rest.some((x) => x === '--output' || x.startsWith('--output=') || x === '--ext-diff' || x === '--open-files-in-pager');
  }
  if (sub === 'remote') return rest.length === 1 && (rest[0] === '-v' || rest[0] === '--verbose');
  if (sub === 'branch') {
    if (rest.some((x) => /^(-d|-D|-m|-M|-c|-C|-f|-u|--delete|--move|--copy|--force|--set-upstream-to.*|--unset-upstream|--edit-description|--track|--no-track)$/.test(x))) return false;
    const listing = has(rest, '--list', '-l', '--contains', '--merged', '--no-merged', '--points-at');
    return listing || !rest.some((x) => !x.startsWith('-'));
  }
  return false;
}

function ghOk(args) {
  const [a, b, ...rest] = args;
  const pair = `${a} ${b}`;
  if (['pr view', 'pr list', 'pr checks', 'pr diff', 'run view', 'run list', 'issue view'].includes(pair)) return true;
  if (a === 'api') {
    const all = args.slice(1);
    for (let i = 0; i < all.length; i++) {
      const x = all[i];
      if (/^(-f|-F|--field|--raw-field|--input)(=|$)/.test(x) || /^-[fF]./.test(x)) return false;
      if (x === '-X' || x === '--method' || x.startsWith('--method=') || x.startsWith('-X')) {
        const v = x === '-X' || x === '--method' ? all[i + 1] : x.startsWith('--method=') ? x.slice(9) : x.slice(2);
        if (String(v).toUpperCase() !== 'GET') return false;
      }
    }
    return !all.some((x) => x === 'graphql');
  }
  return false;
}

function curlOk(args) {
  for (let i = 0; i < args.length; i++) {
    const x = args[i];
    if (x === '-X' || x === '--request' || /^-X./.test(x) || x.startsWith('--request=')) {
      const v = x === '-X' || x === '--request' ? args[i + 1] : x.startsWith('--request=') ? x.slice(10) : x.slice(2);
      if (String(v).toUpperCase() !== 'GET') return false;
      continue;
    }
    if (/^--(data|form|upload-file|output|remote-name|json|dump-header|cookie-jar|config|trace|trace-ascii|stderr)/.test(x)) return false;
    if (/^-[A-Za-z]+$/.test(x) && /[dDFToOcK]/.test(x)) return false;
  }
  return true;
}

function firstOk(w) {
  const [cmd, ...args] = w;
  if (!cmd) return false;
  if (PLAIN.has(cmd)) {
    if (cmd === 'rg' && args.some((x) => x.startsWith('--pre'))) return false;
    if (cmd === 'tail' && (has(args, '-f', '-F', '--follow') || args.some((x) => /^-[a-zA-Z]*[fF]/.test(x)))) return false;
    return true;
  }
  switch (cmd) {
    case 'git': return gitOk(args);
    case 'gh': return ghOk(args);
    case 'curl': return curlOk(args);
    case 'find': return !args.some((x) => /^-(exec|execdir|delete|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(x));
    case 'date': return !args.some((x) => x === '-s' || x === '--set' || x.startsWith('--set=') || /^-[a-z]*s/.test(x));
    case 'lsof': return args.some((x) => x.startsWith('-i')) && !args.includes('-c');
    case 'ps': return true;
    default: return false;
  }
}

const ALLOWED_LOOKS = 'ls, cat, head, tail, grep, rg, find, git log/show/diff/status/branch, gh pr view/list/checks/diff, gh run view/list, gh api GET, curl GET';

function pipelineWhy(segs) {
  if (segs.some((s) => s.length === 0)) return 'empty command or pipe segment';
  for (const s of segs) if (s.some((w) => BANNED_WORDS.has(w))) return `"${s.find((w) => BANNED_WORDS.has(w))}" changes things — hand it to a worker`;
  if (/^\w+=/.test(segs[0][0])) return 'env assignment before a command is not allowed — hand it to a worker';
  if (segs[0][0] === 'cd') return '"cd" is not allowed — pass the path instead (ls <path>, git -C <path> log, cat <path>)';
  if (!firstOk(segs[0])) return `not a read-only command: ${segs[0][0]} — allowed looks: ${ALLOWED_LOOKS}`;
  for (const s of segs.slice(1)) {
    if (!SAFE_PIPE.has(s[0])) return `cannot pipe into ${s[0]} — allowed: head, tail, wc, grep, rg, sort, uniq, cut, jq, sed -n`;
    if (s[0] === 'sort' && s.some((x) => x === '-o' || x.startsWith('--output') || /^-[a-z]*o/.test(x))) return 'sort -o writes — drop -o';
    if (s[0] === 'rg' && s.some((x) => x.startsWith('--pre'))) return 'rg --pre runs commands — drop it';
    if (s[0] === 'sed' && !sedReadOnly(s)) return 'sed is only allowed as read-only "sed -n \'1,20p\'" (no -i, no script file, only p commands)';
  }
  return null;
}

/** { ok:true } when the command is one of her read-only looks (optionally several joined by &&); otherwise { ok:false, why } with the allowed alternative. */
export function readOnlyBash(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return { ok: false, why: 'empty' };
  let pipes;
  try { pipes = parse(cmd); } catch (e) { return { ok: false, why: e.message }; }
  for (const segs of pipes) {
    const why = pipelineWhy(segs);
    if (why) return { ok: false, why };
  }
  return { ok: true };
}
