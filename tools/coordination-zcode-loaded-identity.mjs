import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const phase = process.argv[2];
if (!['before', 'after', 'final'].includes(phase)) throw new Error('Invalid phase');
const options = Object.fromEntries(process.argv.slice(3).map(arg => {
  const match = /^--(out|serial|index)=(.+)$/.exec(arg);
  if (!match) throw new Error('Expected --out=<directory> [--serial=emulator-5554|5556|5558] [--index=0|1|2]');
  return [match[1], match[2]];
}));
if (!options.out?.trim()) throw new Error('Explicit --out=<current evidence directory> required');
const serials = ['emulator-5554', 'emulator-5556', 'emulator-5558'];
if (options.index !== undefined && !/^[012]$/.test(options.index)) throw new Error('Index must be 0, 1 or 2');
const serial = options.serial ?? serials[Number(options.index ?? 2)];
const index = options.index === undefined ? serials.indexOf(serial) : Number(options.index);
if (!serials.includes(serial) || serials[index] !== serial) throw new Error('Serial/index mismatch');
const output = path.resolve(root, options.out);
if (fs.existsSync(output) && fs.readdirSync(output).some(name => name.startsWith(phase + '-loaded-') || name === phase + '-badging.txt')) throw new Error('Phase evidence already exists; use a new --out directory');
const aapt = path.join(root, '.runtime/android-toolchain/sdk/build-tools/35.0.0/aapt.exe');
if (!fs.existsSync(aapt)) throw new Error('Current workspace Android toolchain aapt is missing');
if (!fs.existsSync(path.join(output, phase + '-base.apk'))) throw new Error('Run install-preflight for this phase/output first');
const adb = 'C:/leidian/LDPlayer14/adb.exe';
const run = args => execFileSync(adb, ['-s', serial, ...args], { timeout: 60000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
const hashes = run(['shell', "run-as online.ainiannian.wujinxia sh -c 'find files/engine -type f -exec sha256sum {} \\;'"]);
fs.writeFileSync(path.join(output, phase + '-loaded-hashes.txt'), hashes, { flag: 'wx' });
const processes = run(['shell', 'ps', '-A', '-o', 'PID,PPID,NAME,ARGS']);
const processFile = phase + '-loaded-processes-' + Date.now() + '.txt';
fs.writeFileSync(path.join(output, processFile), processes, { flag: 'wx' });
const badging = execFileSync(aapt, ['dump', 'badging', phase + '-base.apk'], { cwd: output, timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
fs.writeFileSync(path.join(output, phase + '-badging.txt'), badging, { flag: 'wx' });
const packageLine = badging.toString().split('\n').find(one => one.startsWith('package:'));
console.log(JSON.stringify({ phase, serial, index, packageLine, processFile, hashFileBytes: hashes.length,
  hashFileSha256: crypto.createHash('sha256').update(hashes).digest('hex'),
  appProcesses: processes.toString().split('\n').filter(one => one.includes('online.ainiannian.wujinxia')) }, null, 2));
