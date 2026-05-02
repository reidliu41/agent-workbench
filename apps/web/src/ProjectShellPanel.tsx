import React, { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { ServerMessage, Task } from "@agent-workbench/protocol";
import "@xterm/xterm/css/xterm.css";

export function ProjectShellPanel({
  task,
  token,
}: {
  task?: Task;
  token: string;
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const inputDisposableRef = useRef<{ dispose: () => void } | undefined>(undefined);
  const openedRef = useRef(false);
  const resizeObserverRef = useRef<ResizeObserver | undefined>(undefined);
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const terminalRef = useRef<Terminal | undefined>(undefined);
  const fitRef = useRef<FitAddon | undefined>(undefined);
  const [cwd, setCwd] = useState<string>();
  const [status, setStatus] = useState("idle");
  const [attached, setAttached] = useState(false);

  useEffect(() => {
    openedRef.current = false;
    setCwd(undefined);
    setStatus("idle");
    setAttached(false);
    const timer = window.setTimeout(() => {
      if (task && !openedRef.current) {
        openedRef.current = true;
        connectShell("shell.open");
      }
    }, 0);
    return () => {
      window.clearTimeout(timer);
      cleanupShell();
    };
  }, [task?.id]);

  function cleanupShell(): void {
    inputDisposableRef.current?.dispose();
    resizeObserverRef.current?.disconnect();
    socketRef.current?.close();
    terminalRef.current?.dispose();
    inputDisposableRef.current = undefined;
    resizeObserverRef.current = undefined;
    socketRef.current = undefined;
    terminalRef.current = undefined;
    fitRef.current = undefined;
  }

  function ensureTerminal(): { fit: FitAddon; terminal: Terminal } | undefined {
    if (terminalRef.current && fitRef.current) {
      return { fit: fitRef.current, terminal: terminalRef.current };
    }
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }

    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      scrollback: 5000,
      theme: {
        black: "#0b0f10",
        blue: "#7aa2ff",
        brightBlack: "#6f7b7a",
        brightBlue: "#9bb8ff",
        brightCyan: "#8eeaff",
        brightGreen: "#b8ff8d",
        brightMagenta: "#f0a7ff",
        brightRed: "#ff9a8f",
        brightWhite: "#ffffff",
        brightYellow: "#ffe88a",
        background: "#101415",
        cyan: "#68d8ef",
        cursor: "#d7ff7a",
        foreground: "#f0eadf",
        green: "#9be564",
        magenta: "#d99cff",
        red: "#ff776d",
        selectionBackground: "#3a453d",
        white: "#f0eadf",
        yellow: "#ffd866",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    fit.fit();
    terminal.focus();
    terminalRef.current = terminal;
    fitRef.current = fit;

    inputDisposableRef.current = terminal.onData((data) => {
      const socket = socketRef.current;
      if (task && socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          data,
          taskId: task.id,
          type: "shell.input",
        }));
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      const socket = socketRef.current;
      if (!task || socket?.readyState !== WebSocket.OPEN) {
        return;
      }
      fit.fit();
      socket.send(JSON.stringify({
        cols: terminal.cols,
        rows: terminal.rows,
        taskId: task.id,
        type: "shell.resize",
      }));
    });
    resizeObserver.observe(container);
    resizeObserverRef.current = resizeObserver;

    return { fit, terminal };
  }

  function connectShell(kind: "shell.open" | "shell.restart"): void {
    if (!task) {
      return;
    }
    const terminalParts = ensureTerminal();
    if (!terminalParts) {
      return;
    }

    const payload = JSON.stringify({
      cols: terminalParts.terminal.cols,
      rows: terminalParts.terminal.rows,
      taskId: task.id,
      type: kind,
    });
    if (kind === "shell.restart") {
      terminalParts.terminal.reset();
    }

    const existing = socketRef.current;
    if (existing?.readyState === WebSocket.OPEN) {
      existing.send(payload);
      terminalParts.terminal.focus();
      return;
    }

    existing?.close();
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws?token=${encodeURIComponent(token)}`);
    socketRef.current = socket;
    setStatus("connecting");
    socket.addEventListener("open", () => {
      setAttached(true);
      socket.send(payload);
      terminalParts.terminal.focus();
    });
    socket.addEventListener("message", (message) => {
      const parsed = JSON.parse(message.data as string) as ServerMessage | { type: string; error?: string };
      if ("taskId" in parsed && parsed.taskId && parsed.taskId !== task.id) {
        return;
      }
      if (parsed.type === "shell.output" && "data" in parsed && typeof parsed.data === "string") {
        terminalParts.terminal.write(parsed.data);
      }
      if (parsed.type === "shell.status" && "terminal" in parsed && parsed.terminal) {
        setAttached(parsed.terminal.status !== "exited");
        setStatus(parsed.terminal.status);
        setCwd(parsed.terminal.cwd);
      }
      if (parsed.type === "error" && "error" in parsed && parsed.error) {
        terminalParts.terminal.write(`\r\n[Workbench shell error] ${parsed.error}\r\n`);
        setStatus("error");
      }
    });
    socket.addEventListener("close", () => {
      setAttached(false);
      setStatus((current) => (current === "exited" ? current : "detached"));
    });
    socket.addEventListener("error", () => {
      setAttached(false);
      setStatus("error");
    });
  }

  function refitShell(): void {
    const socket = socketRef.current;
    const terminal = terminalRef.current;
    const fit = fitRef.current;
    if (!task || !terminal || !fit || socket?.readyState !== WebSocket.OPEN) {
      return;
    }
    fit.fit();
    socket.send(JSON.stringify({
      cols: terminal.cols,
      rows: terminal.rows,
      taskId: task.id,
      type: "shell.resize",
    }));
    terminal.focus();
  }

  function clearShell(): void {
    terminalRef.current?.clear();
    const socket = socketRef.current;
    if (task && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ taskId: task.id, type: "shell.clear" }));
    }
  }

  function stopShell(): void {
    const socket = socketRef.current;
    if (!task || socket?.readyState !== WebSocket.OPEN) {
      return;
    }
    setStatus("stopping");
    socket.send(JSON.stringify({ taskId: task.id, type: "shell.stop" }));
  }

  if (!task) {
    return <p className="empty">Select a session to open a project shell.</p>;
  }

  return (
    <div className="terminal-panel project-shell-panel">
      <div className="terminal-toolbar">
        <div className="terminal-toolbar-copy">
          <strong>Project shell</strong>
          <small>{cwd ?? "Opening shell in this session worktree..."}</small>
        </div>
        <span className={`terminal-status ${status}`}>{status}</span>
        <button className="secondary compact-button" onClick={() => connectShell(attached ? "shell.restart" : "shell.open")} type="button">
          {attached ? "Restart" : "Attach"}
        </button>
        <button className="secondary compact-button" disabled={!terminalRef.current} onClick={clearShell} type="button">
          Clear
        </button>
        <button className="secondary compact-button" onClick={refitShell} type="button">
          Fit
        </button>
        <button className="danger compact-button" disabled={!attached || !["running", "connecting", "stopping"].includes(status)} onClick={stopShell} type="button">
          Stop
        </button>
      </div>
      <div className="terminal-container" ref={containerRef} />
    </div>
  );
}

export default ProjectShellPanel;
