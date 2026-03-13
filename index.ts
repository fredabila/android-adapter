import { Adapter, Device, Capability } from '@oahl/core';
import { execSync, exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);

// ─── Types ───────────────────────────────────────────────────────────────────

interface AndroidDevice {
  serial: string;
  model: string;
  manufacturer: string;
  androidVersion: string;
  apiLevel: string;
  isOnline: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function adb(serial: string, ...args: string[]): Promise<string> {
  const cmd = `adb -s ${serial} ${args.join(' ')}`;
  try {
    const { stdout } = await execAsync(cmd);
    return stdout.trim();
  } catch (err: any) {
    throw new Error(`ADB command failed [${cmd}]: ${err.message}`);
  }
}

async function adbShell(serial: string, shellCmd: string): Promise<string> {
  return adb(serial, 'shell', shellCmd);
}

async function getAndroidDevices(): Promise<AndroidDevice[]> {
  const { stdout } = await execAsync('adb devices -l');
  const lines = stdout.split('\n').slice(1).filter(l => l.trim() && !l.startsWith('*'));
  const devices: AndroidDevice[] = [];

  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    const serial = parts[0];
    const state = parts[1];
    if (!serial || state !== 'device') continue;

    try {
      const model = (await adbShell(serial, 'getprop ro.product.model')).replace(/\s+/g, '_');
      const manufacturer = await adbShell(serial, 'getprop ro.product.manufacturer');
      const androidVersion = await adbShell(serial, 'getprop ro.build.version.release');
      const apiLevel = await adbShell(serial, 'getprop ro.build.version.sdk');

      devices.push({ serial, model, manufacturer, androidVersion, apiLevel, isOnline: true });
    } catch {
      devices.push({
        serial, model: 'Unknown', manufacturer: 'Unknown',
        androidVersion: '0', apiLevel: '0', isOnline: false,
      });
    }
  }

  return devices;
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class AndroidAdapter implements Adapter {
  id = 'android-adapter';

  private knownDevices: AndroidDevice[] = [];
  private screenshotDir: string;

  constructor(opts: { screenshotDir?: string } = {}) {
    this.screenshotDir = opts.screenshotDir ?? '/tmp/oahl-android-screenshots';
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    console.log(`[${this.id}] Initializing Android adapter…`);

    // Verify adb is available
    try {
      execSync('adb version', { stdio: 'ignore' });
    } catch {
      throw new Error(
        'ADB (Android Debug Bridge) is not installed or not on PATH. ' +
        'Install Android Platform Tools: https://developer.android.com/tools/releases/platform-tools'
      );
    }

    // Start adb server (idempotent)
    await execAsync('adb start-server').catch(() => {});

    // Discover connected devices
    this.knownDevices = await getAndroidDevices();

    if (this.knownDevices.length === 0) {
      console.warn(
        `[${this.id}] No Android devices found. ` +
        'Connect a device over USB (with USB debugging enabled) or start an emulator.'
      );
    } else {
      console.log(
        `[${this.id}] Found ${this.knownDevices.length} device(s): ` +
        this.knownDevices.map(d => `${d.manufacturer} ${d.model} (${d.serial})`).join(', ')
      );
    }

    // Ensure screenshot output dir exists
    fs.mkdirSync(this.screenshotDir, { recursive: true });

    console.log(`[${this.id}] Initialized ✓`);
  }

  // ── Health ─────────────────────────────────────────────────────────────────

  async healthCheck(): Promise<{ status: 'ok' | 'error'; message?: string }> {
    try {
      execSync('adb version', { stdio: 'ignore' });
      const live = await getAndroidDevices();
      if (live.length === 0) {
        return { status: 'error', message: 'No Android devices connected' };
      }
      return { status: 'ok', message: `${live.length} device(s) online` };
    } catch (err: any) {
      return { status: 'error', message: err.message };
    }
  }

  // ── Devices ────────────────────────────────────────────────────────────────

  async getDevices(): Promise<Device[]> {
    // Refresh device list on every call
    this.knownDevices = await getAndroidDevices();

    return this.knownDevices.map(d => ({
      id: d.serial,
      type: 'android',
      name: `${d.manufacturer} ${d.model} (Android ${d.androidVersion}, API ${d.apiLevel})`,
      isPublic: false,
    }));
  }

  // ── Capabilities ──────────────────────────────────────────────────────────

  async getCapabilities(deviceId: string): Promise<Capability[]> {
    const device = this.knownDevices.find(d => d.serial === deviceId);
    if (!device) throw new Error(`Device not found: ${deviceId}`);

    return [
      // ── Screen ──────────────────────────────────────────────────────────
      {
        name: 'screen.screenshot',
        description: 'Capture a screenshot of the device screen.',
        schema: {
          type: 'object',
          properties: {
            format: {
              type: 'string',
              enum: ['png', 'jpg'],
              default: 'png',
              description: 'Output image format.',
            },
            outputPath: {
              type: 'string',
              description: 'Optional local file path to save the screenshot. Defaults to a temp file.',
            },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'screen.record',
        description: 'Record the device screen for a specified duration.',
        schema: {
          type: 'object',
          properties: {
            durationSeconds: {
              type: 'integer',
              minimum: 1,
              maximum: 180,
              default: 10,
              description: 'Recording duration in seconds (max 180).',
            },
            bitrateMbps: {
              type: 'number',
              minimum: 0.5,
              maximum: 20,
              default: 4,
              description: 'Video bitrate in Mbps.',
            },
            outputPath: {
              type: 'string',
              description: 'Optional local path to save the .mp4 file.',
            },
          },
          required: [],
          additionalProperties: false,
        },
      },

      // ── Input ────────────────────────────────────────────────────────────
      {
        name: 'input.tap',
        description: 'Simulate a tap at screen coordinates.',
        schema: {
          type: 'object',
          properties: {
            x: { type: 'integer', minimum: 0, description: 'X coordinate in pixels.' },
            y: { type: 'integer', minimum: 0, description: 'Y coordinate in pixels.' },
          },
          required: ['x', 'y'],
          additionalProperties: false,
        },
      },
      {
        name: 'input.swipe',
        description: 'Simulate a swipe gesture between two points.',
        schema: {
          type: 'object',
          properties: {
            x1: { type: 'integer', minimum: 0 },
            y1: { type: 'integer', minimum: 0 },
            x2: { type: 'integer', minimum: 0 },
            y2: { type: 'integer', minimum: 0 },
            durationMs: {
              type: 'integer',
              minimum: 50,
              maximum: 5000,
              default: 300,
              description: 'Swipe duration in milliseconds.',
            },
          },
          required: ['x1', 'y1', 'x2', 'y2'],
          additionalProperties: false,
        },
      },
      {
        name: 'input.text',
        description: 'Type text into the currently focused input field.',
        schema: {
          type: 'object',
          properties: {
            text: { type: 'string', maxLength: 1000, description: 'Text to type.' },
          },
          required: ['text'],
          additionalProperties: false,
        },
      },
      {
        name: 'input.keyevent',
        description: 'Send a key event (e.g. BACK, HOME, VOLUME_UP).',
        schema: {
          type: 'object',
          properties: {
            keycode: {
              type: 'string',
              description: 'Android keycode name or integer, e.g. "KEYCODE_HOME", "4".',
            },
          },
          required: ['keycode'],
          additionalProperties: false,
        },
      },

      // ── App management ──────────────────────────────────────────────────
      {
        name: 'app.launch',
        description: 'Launch an app by its package name / activity.',
        schema: {
          type: 'object',
          properties: {
            package: { type: 'string', description: 'App package name, e.g. "com.android.settings".' },
            activity: {
              type: 'string',
              description: 'Optional fully-qualified activity. Defaults to the launcher activity.',
            },
          },
          required: ['package'],
          additionalProperties: false,
        },
      },
      {
        name: 'app.stop',
        description: 'Force-stop a running app.',
        schema: {
          type: 'object',
          properties: {
            package: { type: 'string', description: 'App package name to stop.' },
          },
          required: ['package'],
          additionalProperties: false,
        },
      },
      {
        name: 'app.install',
        description: 'Install an APK onto the device.',
        schema: {
          type: 'object',
          properties: {
            apkPath: { type: 'string', description: 'Absolute path to the .apk file on the host machine.' },
            replaceExisting: {
              type: 'boolean',
              default: true,
              description: 'Use -r flag to reinstall if already installed.',
            },
          },
          required: ['apkPath'],
          additionalProperties: false,
        },
      },
      {
        name: 'app.uninstall',
        description: 'Uninstall an app by package name.',
        schema: {
          type: 'object',
          properties: {
            package: { type: 'string' },
            keepData: {
              type: 'boolean',
              default: false,
              description: 'Keep app data and cache directories.',
            },
          },
          required: ['package'],
          additionalProperties: false,
        },
      },
      {
        name: 'app.list',
        description: 'List installed packages on the device.',
        schema: {
          type: 'object',
          properties: {
            filter: {
              type: 'string',
              enum: ['all', 'system', 'third-party', 'enabled', 'disabled'],
              default: 'all',
            },
          },
          required: [],
          additionalProperties: false,
        },
      },

      // ── Files ────────────────────────────────────────────────────────────
      {
        name: 'file.push',
        description: 'Push a file from the host to the device.',
        schema: {
          type: 'object',
          properties: {
            localPath: { type: 'string', description: 'Source path on the host.' },
            remotePath: { type: 'string', description: 'Destination path on the device, e.g. "/sdcard/Download/file.txt".' },
          },
          required: ['localPath', 'remotePath'],
          additionalProperties: false,
        },
      },
      {
        name: 'file.pull',
        description: 'Pull a file from the device to the host.',
        schema: {
          type: 'object',
          properties: {
            remotePath: { type: 'string', description: 'Source path on the device.' },
            localPath: { type: 'string', description: 'Destination path on the host.' },
          },
          required: ['remotePath', 'localPath'],
          additionalProperties: false,
        },
      },

      // ── System info ──────────────────────────────────────────────────────
      {
        name: 'system.info',
        description: 'Return device system information (battery, network, storage, CPU).',
        schema: {
          type: 'object',
          properties: {
            sections: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['battery', 'network', 'storage', 'cpu', 'memory', 'display'],
              },
              default: ['battery', 'network', 'storage'],
              description: 'Which sections to include in the response.',
            },
          },
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: 'system.shell',
        description:
          'Execute a raw shell command on the device. Use with care — no sandboxing is applied.',
        schema: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              maxLength: 2048,
              description: 'Shell command to run, e.g. "ls /sdcard".',
            },
          },
          required: ['command'],
          additionalProperties: false,
        },
      },

      // ── Logcat ──────────────────────────────────────────────────────────
      {
        name: 'logcat.dump',
        description: 'Dump recent logcat output.',
        schema: {
          type: 'object',
          properties: {
            lines: {
              type: 'integer',
              minimum: 1,
              maximum: 5000,
              default: 200,
              description: 'Number of most-recent lines to return.',
            },
            filter: {
              type: 'string',
              description: 'Optional logcat filter expression, e.g. "*:E" for errors only.',
            },
          },
          required: [],
          additionalProperties: false,
        },
      },
    ];
  }

  // ── Execute ───────────────────────────────────────────────────────────────

  async execute(deviceId: string, capabilityName: string, args: any): Promise<any> {
    const device = this.knownDevices.find(d => d.serial === deviceId);
    if (!device) throw new Error(`Device not found: ${deviceId}`);

    switch (capabilityName) {

      // ── Screen ────────────────────────────────────────────────────────────

      case 'screen.screenshot': {
        const fmt = args.format ?? 'png';
        const remotePath = `/sdcard/oahl_screenshot_${Date.now()}.png`;
        const localPath = args.outputPath ?? path.join(this.screenshotDir, `screenshot_${Date.now()}.${fmt}`);

        await adbShell(deviceId, `screencap -p ${remotePath}`);
        await adb(deviceId, 'pull', remotePath, localPath);
        await adbShell(deviceId, `rm -f ${remotePath}`).catch(() => {});

        return { localPath, format: fmt, timestamp: new Date().toISOString() };
      }

      case 'screen.record': {
        const duration = args.durationSeconds ?? 10;
        const bitrate = Math.round((args.bitrateMbps ?? 4) * 1_000_000);
        const remotePath = `/sdcard/oahl_screenrecord_${Date.now()}.mp4`;
        const localPath = args.outputPath ?? path.join(this.screenshotDir, `screenrecord_${Date.now()}.mp4`);

        await execAsync(
          `adb -s ${deviceId} shell screenrecord --time-limit ${duration} --bit-rate ${bitrate} ${remotePath}`
        );
        await adb(deviceId, 'pull', remotePath, localPath);
        await adbShell(deviceId, `rm -f ${remotePath}`).catch(() => {});

        return { localPath, durationSeconds: duration, timestamp: new Date().toISOString() };
      }

      // ── Input ─────────────────────────────────────────────────────────────

      case 'input.tap': {
        await adbShell(deviceId, `input tap ${args.x} ${args.y}`);
        return { tapped: { x: args.x, y: args.y } };
      }

      case 'input.swipe': {
        const dur = args.durationMs ?? 300;
        await adbShell(deviceId, `input swipe ${args.x1} ${args.y1} ${args.x2} ${args.y2} ${dur}`);
        return { swipe: { from: [args.x1, args.y1], to: [args.x2, args.y2], durationMs: dur } };
      }

      case 'input.text': {
        // Escape spaces for shell
        const escaped = args.text.replace(/ /g, '%s');
        await adbShell(deviceId, `input text '${escaped}'`);
        return { typed: args.text };
      }

      case 'input.keyevent': {
        await adbShell(deviceId, `input keyevent ${args.keycode}`);
        return { keycode: args.keycode };
      }

      // ── App ───────────────────────────────────────────────────────────────

      case 'app.launch': {
        if (args.activity) {
          await adbShell(deviceId, `am start -n ${args.package}/${args.activity}`);
        } else {
          await adbShell(deviceId, `monkey -p ${args.package} -c android.intent.category.LAUNCHER 1`);
        }
        return { launched: args.package };
      }

      case 'app.stop': {
        await adbShell(deviceId, `am force-stop ${args.package}`);
        return { stopped: args.package };
      }

      case 'app.install': {
        const flag = args.replaceExisting !== false ? '-r' : '';
        await execAsync(`adb -s ${deviceId} install ${flag} "${args.apkPath}"`);
        return { installed: args.apkPath };
      }

      case 'app.uninstall': {
        const flag = args.keepData ? '-k' : '';
        await execAsync(`adb -s ${deviceId} uninstall ${flag} ${args.package}`);
        return { uninstalled: args.package };
      }

      case 'app.list': {
        const filterMap: Record<string, string> = {
          all: '',
          system: '-s',
          'third-party': '-3',
          enabled: '-e',
          disabled: '-d',
        };
        const flag = filterMap[args.filter ?? 'all'] ?? '';
        const raw = await adbShell(deviceId, `pm list packages ${flag}`);
        const packages = raw
          .split('\n')
          .map(l => l.replace(/^package:/, '').trim())
          .filter(Boolean);
        return { packages, count: packages.length };
      }

      // ── Files ─────────────────────────────────────────────────────────────

      case 'file.push': {
        await execAsync(`adb -s ${deviceId} push "${args.localPath}" "${args.remotePath}"`);
        return { pushed: { from: args.localPath, to: args.remotePath } };
      }

      case 'file.pull': {
        await execAsync(`adb -s ${deviceId} pull "${args.remotePath}" "${args.localPath}"`);
        return { pulled: { from: args.remotePath, to: args.localPath } };
      }

      // ── System ────────────────────────────────────────────────────────────

      case 'system.info': {
        const sections: string[] = args.sections ?? ['battery', 'network', 'storage'];
        const result: Record<string, any> = {};

        if (sections.includes('battery')) {
          const raw = await adbShell(deviceId, 'dumpsys battery');
          const level = raw.match(/level:\s*(\d+)/)?.[1];
          const status = raw.match(/status:\s*(\d+)/)?.[1];
          const plugged = raw.match(/plugged:\s*(\d+)/)?.[1];
          result.battery = { level: level ? parseInt(level) : null, status, plugged };
        }

        if (sections.includes('network')) {
          const wifi = await adbShell(deviceId, 'dumpsys wifi | grep "mNetworkInfo"').catch(() => '');
          const ip = await adbShell(deviceId, 'ip route').catch(() => '');
          result.network = { wifiInfo: wifi.trim(), routes: ip.trim() };
        }

        if (sections.includes('storage')) {
          const df = await adbShell(deviceId, 'df /sdcard');
          result.storage = { df: df.trim() };
        }

        if (sections.includes('cpu')) {
          const cpu = await adbShell(deviceId, 'cat /proc/cpuinfo | grep "Hardware\\|model name\\|processor" | head -10');
          result.cpu = { info: cpu.trim() };
        }

        if (sections.includes('memory')) {
          const mem = await adbShell(deviceId, 'cat /proc/meminfo | head -5');
          result.memory = { info: mem.trim() };
        }

        if (sections.includes('display')) {
          const disp = await adbShell(deviceId, 'wm size && wm density');
          result.display = { info: disp.trim() };
        }

        return result;
      }

      case 'system.shell': {
        const output = await adbShell(deviceId, args.command);
        return { output, command: args.command };
      }

      // ── Logcat ────────────────────────────────────────────────────────────

      case 'logcat.dump': {
        const lines = args.lines ?? 200;
        const filter = args.filter ?? '*:V';
        const raw = await execAsync(
          `adb -s ${deviceId} logcat -d -t ${lines} ${filter}`
        ).then(r => r.stdout).catch(e => e.stdout ?? '');
        return { log: raw.trim(), lines: raw.trim().split('\n').length };
      }

      default:
        throw new Error(`Unknown capability: ${capabilityName}`);
    }
  }
}

// Default export for the OAHL node loader
export default AndroidAdapter;
