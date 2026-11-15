import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { scrubEnv } from '../tools/shell/runner.ts';
import { walkFolder } from './work-folder.ts';

export const FOLDER_DIALOG_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_LIMIT = 64 * 1024;

const DIALOG_SOURCE = String.raw`
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class BeatFolderDialog {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
  private class FileOpenDialogCoClass {}

  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
  }

  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    void SetFileTypeIndex(uint iFileType);
    void GetFileTypeIndex(out uint piFileType);
    void Advise(IntPtr pfde, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOptions(uint fos);
    void GetOptions(out uint pfos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection(out IShellItem ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IShellItem ppsi);
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  private static extern void SHCreateItemFromParsingName(string pszPath, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItem ppv);

  [DllImport("user32.dll")]
  private static extern bool SetForegroundWindow(IntPtr hWnd);

  private const uint FOS_NOCHANGEDIR = 0x8;
  private const uint FOS_PICKFOLDERS = 0x20;
  private const uint FOS_FORCEFILESYSTEM = 0x40;
  private const uint FOS_PATHMUSTEXIST = 0x800;
  private const uint SIGDN_FILESYSPATH = 0x80058000;
  private const int ERROR_CANCELLED = unchecked((int)0x800704C7);

  public static string Pick(string start) {
    Rectangle area = Screen.FromPoint(Cursor.Position).WorkingArea;
    using (Form owner = new Form()) {
      owner.FormBorderStyle = FormBorderStyle.None;
      owner.ShowInTaskbar = false;
      owner.StartPosition = FormStartPosition.Manual;
      owner.Size = new Size(1, 1);
      owner.Location = new Point(area.Left + area.Width / 2, area.Top + area.Height / 3);
      owner.Opacity = 0;
      owner.TopMost = true;
      owner.Show();
      owner.Activate();
      SetForegroundWindow(owner.Handle);
      IFileOpenDialog dialog = (IFileOpenDialog)new FileOpenDialogCoClass();
      try {
        uint options;
        dialog.GetOptions(out options);
        dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_NOCHANGEDIR);
        dialog.SetTitle("beat — Choose a product folder");
        if (!String.IsNullOrEmpty(start)) {
          try {
            IShellItem folder;
            SHCreateItemFromParsingName(start, IntPtr.Zero, typeof(IShellItem).GUID, out folder);
            dialog.SetFolder(folder);
          } catch (Exception) {}
        }
        int hr = dialog.Show(owner.Handle);
        if (hr == ERROR_CANCELLED) return null;
        if (hr != 0) Marshal.ThrowExceptionForHR(hr);
        IShellItem result;
        dialog.GetResult(out result);
        string path;
        result.GetDisplayName(SIGDN_FILESYSPATH, out path);
        return path;
      } finally {
        Marshal.ReleaseComObject(dialog);
      }
    }
  }
}
`;

const DIALOG_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  `Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'\n${DIALOG_SOURCE}\n'@`,
  '$picked = [BeatFolderDialog]::Pick($env:BEAT_PICK_START)',
  "if ($picked) { [Console]::Out.Write('OK:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($picked))) } else { [Console]::Out.Write('CANCEL') }",
].join('\n');

export const DIALOG_ARGS: readonly string[] = ['-NoProfile', '-NonInteractive', '-Sta', '-EncodedCommand', Buffer.from(DIALOG_SCRIPT, 'utf16le').toString('base64')];

export interface DialogChild {
  stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  kill(): unknown;
}

export type DialogSpawn = (command: string, args: readonly string[], env: Record<string, string>) => DialogChild;

export type FolderDialogResult = { path: string } | { cancelled: true };

export class FolderDialogError extends Error {
  readonly code: 'busy' | 'unsupported' | 'failed';
  constructor(code: 'busy' | 'unsupported' | 'failed') { super(code); this.code = code; }
}

export interface FolderDialogOptions {
  platform?: NodeJS.Platform;
  spawn?: DialogSpawn;
  timeoutMs?: number;
  log?: (line: string) => void;
}

const realSpawn: DialogSpawn = (command, args, env) => spawn(command, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });

const powershellPath = (): string => join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function startFolder(input: string | undefined): string {
  const walked = input ? walkFolder(input) : undefined;
  return walked?.ok && walked.directory ? walked.path : homedir();
}

export class FolderDialog {
  readonly #platform: NodeJS.Platform;
  readonly #spawn: DialogSpawn;
  readonly #timeoutMs: number;
  readonly #log: (line: string) => void;
  #cancel: (() => void) | null = null;

  constructor(options: FolderDialogOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#spawn = options.spawn ?? realSpawn;
    this.#timeoutMs = options.timeoutMs ?? FOLDER_DIALOG_TIMEOUT_MS;
    this.#log = options.log ?? (() => undefined);
  }

  get supported(): boolean { return this.#platform === 'win32'; }

  get open(): boolean { return this.#cancel !== null; }

  pick(start: string | undefined, signal?: AbortSignal): Promise<FolderDialogResult> {
    if (!this.supported) return Promise.reject(new FolderDialogError('unsupported'));
    if (this.#cancel) return Promise.reject(new FolderDialogError('busy'));
    const env = { ...scrubEnv(), BEAT_PICK_START: startFolder(start) };
    let child: DialogChild;
    try { child = this.#spawn(powershellPath(), DIALOG_ARGS, env); } catch (error) {
      this.#log(`[ERROR] Could not open the folder window: ${(error as Error).message}`);
      return Promise.reject(new FolderDialogError('failed'));
    }
    return new Promise((resolve, reject) => {
      let out = '';
      let done = false;
      const finish = (run: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (this.#cancel === onAbort) this.#cancel = null;
        run();
      };
      const onAbort = () => { try { child.kill(); } catch { } finish(() => resolve({ cancelled: true })); };
      this.#cancel = onAbort;
      const timer = setTimeout(onAbort, this.#timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      child.stdout?.on('data', chunk => { if (out.length < OUTPUT_LIMIT) out += chunk.toString('utf8'); });
      child.on('error', error => {
        this.#log(`[ERROR] Could not open the folder window: ${error.message}`);
        finish(() => reject(new FolderDialogError('failed')));
      });
      child.on('close', code => finish(() => {
        const text = out.trim();
        if (code === 0 && text === 'CANCEL') { resolve({ cancelled: true }); return; }
        const path = code === 0 && text.startsWith('OK:') ? Buffer.from(text.slice(3), 'base64').toString('utf8') : '';
        if (path && isAbsolute(path)) { resolve({ path }); return; }
        this.#log(`[ERROR] The folder window ended without a usable answer (exit code ${code ?? 'none'})`);
        reject(new FolderDialogError('failed'));
      }));
    });
  }

  stop(): void {
    this.#cancel?.();
  }
}
