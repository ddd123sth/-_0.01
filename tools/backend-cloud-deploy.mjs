// Independent new-cloud release and protected Android signing preparation.
// No game account, old cloud password store, APK data or original website source is read.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = path.join(project, '.runtime/backend-rebuild');
const host = 'aliyun-huantong', service = 'wujinxia-backend-cloud';
const args = new Set(process.argv.slice(2));
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function invoke(executable, argv, options = {}) {
  const result = spawnSync(executable, argv, { cwd: project, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...options });
  if (result.error || result.status !== 0) {
    const error = new Error(path.basename(executable) + ' failed; no credential values were emitted');
    error.safeDetail = String(result.stderr || '').slice(-4000);
    throw error;
  }
  return String(result.stdout || '').trim();
}
function write(file, contents) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, contents); }
function sources(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    if (entry.isSymbolicLink()) throw new Error('Release source cannot contain symbolic links');
    const full = path.join(directory, entry.name), relative = prefix ? prefix + '/' + entry.name : entry.name;
    return entry.isDirectory() ? sources(full, relative) : [{ full, relative }];
  });
}
function protectKeys(directory) {
  fs.mkdirSync(directory, { recursive: true });
  if (process.platform !== 'win32') { fs.chmodSync(directory, 0o700); return; }
  const identity = /S-1-5-21-[0-9-]+/.exec(invoke('whoami.exe', ['/user', '/fo', 'csv', '/nh']))?.[0];
  if (!identity) throw new Error('Cannot establish the current signing-file owner');
  const allowed = [identity, 'S-1-5-18', 'S-1-5-32-544'];
  const files = fs.readdirSync(directory).map(name => path.join(directory, name));
  for (const file of files) if (!fs.lstatSync(file).isFile()) throw new Error('Unexpected object in signing directory');
  for (const target of [directory, ...files]) {
    const inheritance = target === directory ? '(OI)(CI)F' : 'F';
    // icacls edits only the DACL; it does not require SeSecurityPrivilege to
    // write a newly constructed audit descriptor in a child process.
    invoke('icacls.exe', [target, '/inheritance:r', '/grant:r', ...allowed.map(sid => '*' + sid + ':' + inheritance)]);
  }
  const script = `
$ErrorActionPreference = 'Stop'
$target = $env:WUJINXIA_NEW_KEY_DIRECTORY
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$allowed = @($identity.Value, 'S-1-5-18', 'S-1-5-32-544')
foreach ($item in @((Get-Item -LiteralPath $target)) + @(Get-ChildItem -LiteralPath $target -File)) {
  $acl = Get-Acl -LiteralPath $item.FullName
  if (-not $acl.AreAccessRulesProtected) { throw 'Signing object still inherits unexpected permissions' }
  foreach ($entry in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) {
    if ($entry.AccessControlType -eq 'Allow' -and $entry.IdentityReference.Value -notin $allowed) { throw 'Signing object ACL contains an unexpected principal' }
  }
}
Write-Output 'protected'
`;
  invoke('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, WUJINXIA_NEW_KEY_DIRECTORY: directory },
  });
}
function prepareKeys() {
  const directory = path.join(work, 'keys');
  protectKeys(directory);
  const keystore = path.join(directory, 'wujinxia-backend-v1.p12');
  const storePasswordFile = path.join(directory, 'store-password.txt');
  const keyPasswordFile = path.join(directory, 'key-password.txt');
  const alias = 'wujinxia-backend-v1';
  if (!fs.existsSync(keystore)) {
    if (fs.existsSync(storePasswordFile) || fs.existsSync(keyPasswordFile)) throw new Error('Partial signing source exists; inspect it without overwriting');
    const password = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(storePasswordFile, password + '\n', { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(keyPasswordFile, password + '\n', { mode: 0o600, flag: 'wx' });
    const javaHome = fs.readFileSync(path.join(project, '.runtime/android-toolchain/java-home.txt'), 'utf8').trim();
    invoke(path.join(javaHome, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool'),
      ['-genkeypair', '-keystore', keystore, '-storetype', 'PKCS12', '-alias', alias, '-keyalg', 'RSA',
        '-keysize', '3072', '-sigalg', 'SHA256withRSA', '-validity', '10000',
        '-dname', 'CN=WuJinXia Backend Android,OU=Android,O=WuJinXia,C=CN',
        '-storepass:file', storePasswordFile, '-keypass:file', keyPasswordFile, '-noprompt']);
  }
  if (!fs.existsSync(storePasswordFile) || !fs.existsSync(keyPasswordFile)) throw new Error('Protected signing password sources are missing');
  protectKeys(directory);
  const javaHome = fs.readFileSync(path.join(project, '.runtime/android-toolchain/java-home.txt'), 'utf8').trim();
  const certificate = invoke(path.join(javaHome, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool'),
    ['-exportcert', '-rfc', '-keystore', keystore, '-alias', alias, '-storepass:file', storePasswordFile]);
  const publicCertificate = new crypto.X509Certificate(certificate);
  const result = { applicationId: 'online.ainiannian.wujinxia', keystore, alias, storePasswordFile, keyPasswordFile,
    certificateSha256: publicCertificate.fingerprint256, validFrom: publicCertificate.validFrom, validTo: publicCertificate.validTo,
    passwordValuesEmitted: false, protectedDirectory: directory };
  write(path.join(work, 'signing-manifest.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}
function prepareRelease() {
  invoke(process.execPath, [path.join(project, 'tools/build-admin.mjs')]);
  const draft = path.join(work, 'cloud-stage');
  const relative = path.relative(work, draft);
  if (relative !== 'cloud-stage') throw new Error('Unsafe release staging target');
  fs.rmSync(draft, { recursive: true, force: true });
  fs.mkdirSync(draft, { recursive: true });
  for (const item of sources(path.join(project, 'cloud'))) {
    if (!item.relative.endsWith('.mjs')) throw new Error('Unexpected cloud source format');
    let text = fs.readFileSync(item.full, 'utf8');
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) throw new Error('Private key cannot enter release');
    if (item.relative === 'config.mjs') {
      if (!text.includes("export const SERVICE_NAME = 'wujinxia-app-cloud';") || !text.includes("export const SERVICE_VERSION = '0.1.0';")) throw new Error('Review new-cloud release identity transformation');
      text = text.replace("export const SERVICE_NAME = 'wujinxia-app-cloud';", "export const SERVICE_NAME = 'wujinxia-backend-cloud';")
        .replace("export const SERVICE_VERSION = '0.1.0';", "export const SERVICE_VERSION = '0.2.0-backend';");
    }
    write(path.join(draft, 'cloud', item.relative), text);
  }
  for (const item of sources(path.join(project, 'admin/dist'))) write(path.join(draft, 'admin/dist', item.relative), fs.readFileSync(item.full));
  for (const item of sources(path.join(project, 'deploy/backend-rebuild'))) write(path.join(draft, 'deploy/backend-rebuild', item.relative), fs.readFileSync(item.full));
  const files = sources(draft).map(item => ({ file: item.relative, sha256: digest(fs.readFileSync(item.full)) }));
  const releaseId = digest(JSON.stringify(files)).slice(0, 24);
  write(path.join(draft, 'release-manifest.json'), JSON.stringify({ service, releaseId, files }, null, 2) + '\n');
  const archive = path.join(work, service + '-' + releaseId + '.tar.gz');
  invoke(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-czf', archive, '-C', draft, '.']);
  return { releaseId, archive, fileCount: files.length, archiveSha256: digest(fs.readFileSync(archive)) };
}
function deploy(release) {
  const remoteArchive = '/tmp/' + service + '-' + release.releaseId + '.tar.gz';
  const remoteSource = '/tmp/' + service + '-' + release.releaseId;
  invoke('scp', ['-q', '-o', 'BatchMode=yes', release.archive, host + ':' + remoteArchive]);
  const remote = `
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const archive=${JSON.stringify(remoteArchive)},source=${JSON.stringify(remoteSource)};
try {
  if(!fs.existsSync(source)){fs.mkdirSync(source,{mode:0o700});execFileSync('tar',['-xzf',archive,'-C',source]);}
  fs.chmodSync(archive,0o600);
  const {installRelease}=await import(pathToFileURL(source+'/deploy/backend-rebuild/install.mjs'));
  const result=await installRelease({source,releaseId:${JSON.stringify(release.releaseId)}});
  console.log(JSON.stringify({ok:true,...result}));
}catch(error){console.error(JSON.stringify({ok:false,error:String(error.message)}));process.exitCode=1;}
`;
  const output = invoke('ssh', ['-o', 'BatchMode=yes', host, 'node', '--input-type=module', '-'], { input: remote, timeout: 120000 });
  const result = JSON.parse(output.split('\n').at(-1));
  if (!result.ok) throw new Error('Independent cloud deployment did not confirm completion');
  write(path.join(work, 'deployment-result.json'), JSON.stringify({ measuredAt: new Date().toISOString(), ...result, localRelease: release }, null, 2) + '\n');
  return result;
}
try {
  fs.mkdirSync(work, { recursive: true });
  if (args.has('--prepare-keys')) console.log(JSON.stringify({ signing: prepareKeys() }, null, 2));
  else {
    const release = prepareRelease();
    console.log(JSON.stringify({ prepared: release, applied: args.has('--apply') }));
    if (args.has('--apply')) console.log(JSON.stringify(deploy(release), null, 2));
  }
} catch (error) {
  console.error(error.message);
  if (error.safeDetail) console.error(error.safeDetail);
  process.exitCode = 1;
}
