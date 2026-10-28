// Portable clipboard fallbacks adapted from the canonical extension.
import { spawn } from "node:child_process";
export const CLIPBOARD_TIMEOUT_MS = 5000;
export const MAX_OSC52_ENCODED_LENGTH = 1e5;
export function runClipboardCommand({ command, args }, text, spawnProcess = spawn, timeoutMs = CLIPBOARD_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(command, args, {
        stdio: ["pipe", "ignore", "ignore"]
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    let settled = false;
    let timer;
    const settle = (finish) => {
      if (settled)
        return;
      settled = true;
      if (timer !== undefined)
        clearTimeout(timer);
      finish();
    };
    const fail = (error) => {
      settle(() => reject(error instanceof Error ? error : new Error(String(error))));
    };
    child.once("error", fail);
    child.once("close", (code) => {
      if (code === 0)
        settle(resolve);
      else
        settle(() => reject(new Error(`${command} exited with code ${code ?? "unknown"}`)));
    });
    timer = setTimeout(() => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {}
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (settled) {
      clearTimeout(timer);
      return;
    }
    if (!child.stdin) {
      try {
        child.kill();
      } catch {}
      fail(new Error(`${command} has no writable stdin`));
      return;
    }
    child.stdin.once("error", fail);
    child.stdin.end(text);
  });
}
function withTimeout(start, timeoutMs, operation) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled)
        return;
      settled = true;
      reject(new Error(`${operation} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const finish = (callback) => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    try {
      Promise.resolve(start()).then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error instanceof Error ? error : new Error(String(error)))));
    } catch (error) {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))));
    }
  });
}
export function emitOsc52(text) {
  const encoded = Buffer.from(text).toString("base64");
  if (encoded.length > MAX_OSC52_ENCODED_LENGTH)
    return false;
  try {
    process.stdout.write(`\x1B]52;c;${encoded}\x07`);
    return true;
  } catch {
    return false;
  }
}
function isRemoteSession(env) {
  return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION);
}
export async function fallbackCopyToClipboard(text, deps = {}) {
  const env = deps.env ?? process.env;
  const timeoutMs = deps.timeoutMs ?? CLIPBOARD_TIMEOUT_MS;
  const browserNavigator = deps.navigator ?? globalThis.navigator;
  let copied = false;
  let lastError;
  if (browserNavigator?.clipboard) {
    try {
      await withTimeout(() => browserNavigator.clipboard.writeText(text), timeoutMs, "navigator.clipboard.writeText");
      copied = true;
    } catch (error) {
      lastError = error;
    }
  }
  const platform = deps.platform ?? process.platform;
  const commands = platform === "darwin" ? [{ command: "pbcopy", args: [] }] : platform === "win32" ? [{ command: "clip", args: [] }] : platform === "linux" ? [
    ...env.TERMUX_VERSION ? [{ command: "termux-clipboard-set", args: [] }] : [],
    ...env.WAYLAND_DISPLAY ? [{ command: "wl-copy", args: [] }] : [],
    ...env.DISPLAY ? [
      { command: "xclip", args: ["-selection", "clipboard"] },
      { command: "xsel", args: ["--clipboard", "--input"] }
    ] : []
  ] : [];
  const runCommand = deps.runCommand ?? ((command, value, deadline) => runClipboardCommand(command, value, deps.spawn, deadline));
  if (!copied) {
    for (const command of commands) {
      try {
        await runCommand(command, text, timeoutMs);
        copied = true;
        break;
      } catch (error) {
        lastError = error;
      }
    }
  }
  const emit = deps.emitOsc52 ?? emitOsc52;
  if (isRemoteSession(env) || !copied) {
    const encodedLength = Buffer.from(text).toString("base64").length;
    if (encodedLength <= MAX_OSC52_ENCODED_LENGTH) {
      try {
        if (emit(text))
          return;
      } catch (error) {
        lastError = error;
      }
    }
  }
  if (copied)
    return;
  throw lastError instanceof Error ? lastError : new Error("No supported clipboard utility is available");
}
export async function copyPromptText(text, notify, writeClipboard) {
  try {
    const write = writeClipboard ?? fallbackCopyToClipboard;
    await write(text);
    notify("Prompt copied to clipboard", "info");
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notify(`Prompt copy failed: ${message}`, "error");
    return false;
  }
}
