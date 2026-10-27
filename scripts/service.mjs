// Run una on her own (macOS): installs or removes a launchd agent that starts her at login
// and restarts her if she stops. Usage: npm run install-service / npm run uninstall-service.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LABEL = process.env.UNA_SERVICE_LABEL || process.env.SAHAR_SERVICE_LABEL || 'local.una';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG = path.join(process.env.DATA_DIR || path.join(REPO, 'data'), 'una.log');
const LEGACY_LABEL = 'local.sahar'; // pre-rename agent; removed on install so upgrades never run two
const LEGACY_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LEGACY_LABEL}.plist`);
const domain = `gui/${process.getuid()}`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The launchd plist for this checkout, using the node that is running this script. */
export function plist() {
  const env = {
    HOME: os.homedir(),
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    ...(process.env.PORT ? { PORT: process.env.PORT } : {}),
    ...(process.env.HUB_DIR ? { HUB_DIR: process.env.HUB_DIR } : {}),
    ...(process.env.DATA_DIR ? { DATA_DIR: process.env.DATA_DIR } : {}),
  };
  const envXml = Object.entries(env).map(([k, v]) => `\t\t<key>${esc(k)}</key>\n\t\t<string>${esc(v)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${esc(LABEL)}</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>${esc(process.execPath)}</string>
\t\t<string>server.mjs</string>
\t</array>
\t<key>WorkingDirectory</key>
\t<string>${esc(REPO)}</string>
\t<key>EnvironmentVariables</key>
\t<dict>
${envXml}
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>ThrottleInterval</key>
\t<integer>10</integer>
\t<key>StandardOutPath</key>
\t<string>${esc(LOG)}</string>
\t<key>StandardErrorPath</key>
\t<string>${esc(LOG)}</string>
</dict>
</plist>
`;
}

const launchctl = (...args) => { try { execFileSync('launchctl', args, { stdio: 'pipe' }); return true; } catch { return false; } };

function install() {
  if (process.platform !== 'darwin') { console.error('install-service uses launchd and only works on macOS. Run "npm start" instead.'); process.exit(1); }
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  if (LEGACY_LABEL !== LABEL) {
    launchctl('bootout', `${domain}/${LEGACY_LABEL}`);
    try { fs.unlinkSync(LEGACY_PLIST); } catch {}
  }
  launchctl('bootout', `${domain}/${LABEL}`); // replace a previous install
  fs.writeFileSync(PLIST, plist());
  if (!launchctl('bootstrap', domain, PLIST)) { console.error(`launchctl could not load ${PLIST}`); process.exit(1); }
  launchctl('kickstart', '-k', `${domain}/${LABEL}`);
  console.log(`Una is running as a service (${LABEL}). Open http://localhost:${process.env.PORT || 4747}\nLog: ${LOG}\nRemove with: npm run uninstall-service`);
}

function uninstall() {
  launchctl('bootout', `${domain}/${LABEL}`);
  try { fs.unlinkSync(PLIST); } catch {}
  console.log(`Una service (${LABEL}) removed. Your hub and data are untouched.`);
}

if (process.argv[2] === 'install') install();
else if (process.argv[2] === 'uninstall') uninstall();
else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { console.error('usage: node scripts/service.mjs install|uninstall'); process.exit(1); }
