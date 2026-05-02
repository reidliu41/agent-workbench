import React, { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { ServerMessage, Task, UploadSessionImageResponse } from "@agent-workbench/protocol";
import "@xterm/xterm/css/xterm.css";

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly 0: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionResultListLike {
  readonly length: number;
  readonly [index: number]: SpeechRecognitionResultLike;
}

interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultListLike;
}

interface SpeechRecognitionErrorEventLike {
  readonly error?: string;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onend: (() => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  abort(): void;
  start(): void;
  stop(): void;
}

export function TerminalPanel({
  autoAttach = false,
  isProjected = false,
  onProjectionLinesChange,
  onToggleProjection,
  task,
  token,
}: {
  autoAttach?: boolean;
  isProjected?: boolean;
  onProjectionLinesChange?: (lines: string[]) => void;
  onToggleProjection?: () => void;
  task?: Task;
  token: string;
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const inputDisposableRef = useRef<{ dispose: () => void } | undefined>(undefined);
  const autoAttachAttemptedRef = useRef(false);
  const replaySettleTimerRef = useRef<number | undefined>(undefined);
  const resizeObserverRef = useRef<ResizeObserver | undefined>(undefined);
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const pasteListenerCleanupRef = useRef<(() => void) | undefined>(undefined);
  const projectionUpdateTimerRef = useRef<number | undefined>(undefined);
  const speechRecognitionRef = useRef<SpeechRecognitionLike | undefined>(undefined);
  const suppressInputRef = useRef(false);
  const terminalRef = useRef<Terminal | undefined>(undefined);
  const fitRef = useRef<FitAddon | undefined>(undefined);
  const voiceRestartTimerRef = useRef<number | undefined>(undefined);
  const voiceStopRequestedRef = useRef(false);
  const [activeCommand, setActiveCommand] = useState<string>();
  const [customCommand, setCustomCommand] = useState("");
  const [selectedCommand, setSelectedCommand] = useState("gemini");
  const [status, setStatus] = useState("idle");
  const [attached, setAttached] = useState(false);
  const [clipboardStatus, setClipboardStatus] = useState<string>();
  const [isUploadingClipboardImage, setIsUploadingClipboardImage] = useState(false);
  const [claudeTrustPromptVisible, setClaudeTrustPromptVisible] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<"idle" | "listening" | "unsupported" | "error">(() =>
    speechRecognitionConstructor() ? "idle" : "unsupported",
  );
  const linkedGemini = linkedGeminiSessionId(task);
  const linkedCodex = linkedCodexSessionId(task);
  const linkedClaude = linkedClaudeSessionId(task);
  const waitingForGeminiSession = isGeminiWorkbenchSession(task) && !linkedGemini;
  const waitingForCodexSession = isCodexWorkbenchSession(task) && !linkedCodex;
  const waitingForClaudeSession = isClaudeWorkbenchSession(task) && !linkedClaude;

  useEffect(() => {
    setActiveCommand(undefined);
    setStatus("idle");
    setAttached(false);
    setClipboardStatus(undefined);
    setClaudeTrustPromptVisible(false);
    setIsUploadingClipboardImage(false);
    autoAttachAttemptedRef.current = false;
    let nextSelectedCommand = defaultTerminalCommandForTask(task);
    let nextCustomCommand = "";
    if (task && !fixedTerminalCommandForTask(task)) {
      const stored = window.localStorage.getItem(terminalCommandStorageKey(task.id));
      if (stored && terminalCommandOptions.some((option) => option.value === stored)) {
        nextSelectedCommand = stored;
      } else if (stored) {
        nextSelectedCommand = "custom";
        nextCustomCommand = stored;
      }
    }
    setSelectedCommand(nextSelectedCommand);
    setCustomCommand(nextCustomCommand);

    return cleanupTerminal;
  }, [task?.id]);

  useEffect(() => {
    if (!task || !autoAttach || autoAttachAttemptedRef.current || socketRef.current || terminalRef.current) {
      return;
    }
    autoAttachAttemptedRef.current = true;
    const attachTimer = window.setTimeout(() => {
      connectTerminalFor(task, selectedCommand, customCommand, "terminal.open");
    }, 0);
    return () => window.clearTimeout(attachTimer);
  }, [autoAttach, customCommand, selectedCommand, task?.id]);

  useEffect(() => {
    if (isProjected && terminalRef.current) {
      onProjectionLinesChange?.(projectionLinesFromTerminal(terminalRef.current));
    }
  }, [isProjected, onProjectionLinesChange]);

  function cleanupTerminal(): void {
    const socket = socketRef.current;
    if (replaySettleTimerRef.current !== undefined) {
      window.clearTimeout(replaySettleTimerRef.current);
      replaySettleTimerRef.current = undefined;
    }
    suppressInputRef.current = false;
    voiceStopRequestedRef.current = true;
    if (voiceRestartTimerRef.current !== undefined) {
      window.clearTimeout(voiceRestartTimerRef.current);
      voiceRestartTimerRef.current = undefined;
    }
    if (projectionUpdateTimerRef.current !== undefined) {
      window.clearTimeout(projectionUpdateTimerRef.current);
      projectionUpdateTimerRef.current = undefined;
    }
    inputDisposableRef.current?.dispose();
    pasteListenerCleanupRef.current?.();
    resizeObserverRef.current?.disconnect();
    speechRecognitionRef.current?.abort();
    socket?.close();
    terminalRef.current?.dispose();
    inputDisposableRef.current = undefined;
    pasteListenerCleanupRef.current = undefined;
    resizeObserverRef.current = undefined;
    socketRef.current = undefined;
    speechRecognitionRef.current = undefined;
    terminalRef.current = undefined;
    fitRef.current = undefined;
    onProjectionLinesChange?.([]);
    setVoiceStatus(speechRecognitionConstructor() ? "idle" : "unsupported");
  }

  function scheduleProjectionUpdate(): void {
    if (!onProjectionLinesChange || projectionUpdateTimerRef.current !== undefined) {
      return;
    }
    projectionUpdateTimerRef.current = window.setTimeout(() => {
      projectionUpdateTimerRef.current = undefined;
      const terminal = terminalRef.current;
      if (terminal) {
        onProjectionLinesChange(projectionLinesFromTerminal(terminal));
      }
    }, 80);
  }

  function armReplaySettleTimer(): void {
    if (replaySettleTimerRef.current !== undefined) {
      window.clearTimeout(replaySettleTimerRef.current);
    }
    replaySettleTimerRef.current = window.setTimeout(() => {
      suppressInputRef.current = false;
      replaySettleTimerRef.current = undefined;
    }, 140);
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
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      scrollback: 5000,
      theme: {
        background: "#101415",
        foreground: "#e7e2d7",
        cursor: "#d7ff7a",
        selectionBackground: "#3a453d",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    fit.fit();
    terminal.focus();
    terminalRef.current = terminal;
    fitRef.current = fit;
    pasteListenerCleanupRef.current?.();
    pasteListenerCleanupRef.current = installTerminalPasteListener(container, (event) => {
      void handleNativeTerminalPaste(event);
    });

    inputDisposableRef.current = terminal.onData((data) => {
      if (suppressInputRef.current) {
        return;
      }
      const socket = socketRef.current;
      if (task && socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          data,
          taskId: task.id,
          type: "terminal.input",
        }));
        scheduleProjectionUpdate();
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
        type: "terminal.resize",
      }));
    });
    resizeObserver.observe(container);
    resizeObserverRef.current = resizeObserver;

    return { fit, terminal };
  }

  function connectTerminal(kind: "terminal.open" | "terminal.restart"): void {
    if (!task) {
      return;
    }
    connectTerminalFor(task, selectedCommand, customCommand, kind);
  }

  function connectTerminalFor(
    targetTask: Task,
    targetSelectedCommand: string,
    targetCustomCommand: string,
    kind: "terminal.open" | "terminal.restart",
  ): void {
    const terminalParts = ensureTerminal();
    if (!terminalParts) {
      return;
    }

    const command = resolvedTerminalCommand(targetSelectedCommand, targetCustomCommand, targetTask);
    if (!command) {
      setStatus("error");
      return;
    }
    window.localStorage.setItem(terminalCommandStorageKey(targetTask.id), command);
    setActiveCommand(command);
    setAttached(true);
    setStatus("connecting");
    suppressInputRef.current = true;
    armReplaySettleTimer();
    terminalParts.fit.fit();
    if (kind === "terminal.restart") {
      terminalParts.terminal.reset();
    }

    const payload = JSON.stringify({
      cols: terminalParts.terminal.cols,
      command,
      rows: terminalParts.terminal.rows,
      taskId: targetTask.id,
      type: kind,
    });
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
      armReplaySettleTimer();
      terminalParts.terminal.focus();
    });
    socket.addEventListener("message", (message) => {
      const parsed = JSON.parse(message.data as string) as ServerMessage | { type: string; error?: string };
      if ("taskId" in parsed && parsed.taskId && parsed.taskId !== targetTask.id) {
        return;
      }
      if (parsed.type === "terminal.output" && "data" in parsed && typeof parsed.data === "string") {
        const output = parsed.data;
        if (suppressInputRef.current) {
          armReplaySettleTimer();
        }
        if (isClaudeCliCommand(command)) {
          setClaudeTrustPromptVisible((visible) => detectClaudeTrustPrompt(output) || visible);
        }
        const normalized = normalizeTerminalOutput(output, command);
        terminalParts.terminal.write(normalized, scheduleProjectionUpdate);
      }
      if (parsed.type === "terminal.status" && "terminal" in parsed && parsed.terminal) {
        if (suppressInputRef.current) {
          armReplaySettleTimer();
        }
        setAttached(parsed.terminal.status !== "exited");
        setStatus(parsed.terminal.status);
        setActiveCommand(parsed.terminal.command ?? command);
      }
      if (parsed.type === "error" && "error" in parsed && parsed.error) {
        const errorOutput = `\r\n[Workbench error] ${parsed.error}\r\n`;
        terminalParts.terminal.write(errorOutput, scheduleProjectionUpdate);
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

  function refitTerminal(): void {
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
      type: "terminal.resize",
    }));
    terminal.focus();
  }

  function writeTerminalInput(data: string): boolean {
    const socket = socketRef.current;
    if (!task || socket?.readyState !== WebSocket.OPEN) {
      return false;
    }
    socket.send(JSON.stringify({
      data,
      taskId: task.id,
      type: "terminal.input",
    }));
    if (data.trim() || data === "\r" || data === "\n") {
      setClaudeTrustPromptVisible(false);
    }
    terminalRef.current?.focus();
    return true;
  }

  function pasteTerminalInput(data: string): boolean {
    const socket = socketRef.current;
    const terminal = terminalRef.current;
    if (!task || !terminal || socket?.readyState !== WebSocket.OPEN) {
      return false;
    }
    terminal.paste(data);
    terminal.focus();
    return true;
  }

  async function uploadClipboardImage(
    taskId: string,
    input: { contentBase64: string; fileName: string; mimeType: string },
  ): Promise<UploadSessionImageResponse> {
    const response = await fetch(`/api/sessions/${encodeURIComponent(taskId)}/uploads/images?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(errorMessageFromResponse(text, response.statusText));
    }
    return response.json() as Promise<UploadSessionImageResponse>;
  }

  async function handleNativeTerminalPaste(event: ClipboardEvent): Promise<void> {
    const imageFile = event.clipboardData ? clipboardImageFile(event.clipboardData) : undefined;
    if (!imageFile) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    if (!task || socketRef.current?.readyState !== WebSocket.OPEN) {
      setClipboardStatus("Attach terminal before pasting screenshots.");
      terminalRef.current?.focus();
      return;
    }

    setClipboardStatus("Uploading screenshot...");
    setIsUploadingClipboardImage(true);
    try {
      const contentBase64 = await fileToBase64(imageFile);
      const uploaded = await uploadClipboardImage(task.id, {
        contentBase64,
        fileName: imageFile.name || "clipboard-image",
        mimeType: imageFile.type || "image/png",
      });
      const reference = `${uploaded.reference} `;
      if (pasteTerminalInput(reference)) {
        setClipboardStatus(`Inserted ${uploaded.reference}`);
      } else {
        setClipboardStatus("Screenshot saved, but terminal is not attached.");
      }
    } catch (error) {
      setClipboardStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsUploadingClipboardImage(false);
      terminalRef.current?.focus();
    }
  }

  function toggleVoiceInput(): void {
    if (voiceStatus === "listening") {
      voiceStopRequestedRef.current = true;
      if (voiceRestartTimerRef.current !== undefined) {
        window.clearTimeout(voiceRestartTimerRef.current);
        voiceRestartTimerRef.current = undefined;
      }
      speechRecognitionRef.current?.stop();
      speechRecognitionRef.current = undefined;
      setVoiceStatus("idle");
      terminalRef.current?.focus();
      return;
    }

    const Recognition = speechRecognitionConstructor();
    if (!Recognition) {
      setVoiceStatus("unsupported");
      return;
    }
    if (!task || socketRef.current?.readyState !== WebSocket.OPEN) {
      setVoiceStatus("error");
      terminalRef.current?.write("\r\n[Workbench voice] Attach terminal before starting voice input.\r\n");
      return;
    }

    voiceStopRequestedRef.current = false;
    startVoiceRecognition(Recognition);
  }

  function startVoiceRecognition(Recognition: SpeechRecognitionConstructor): void {
    if (voiceStopRequestedRef.current) {
      return;
    }
    if (!task || socketRef.current?.readyState !== WebSocket.OPEN) {
      setVoiceStatus("error");
      return;
    }

    const recognition = new Recognition();
    speechRecognitionRef.current = recognition;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";
    recognition.onresult = (event) => {
      let finalText = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result?.isFinal) {
          finalText += result[0]?.transcript ?? "";
        }
      }
      const text = finalText.trim();
      if (text) {
        writeTerminalInput(`${text} `);
      }
    };
    recognition.onerror = (event) => {
      if (voiceStopRequestedRef.current || event.error === "aborted") {
        return;
      }
      if (event.error === "no-speech" && !voiceStopRequestedRef.current) {
        return;
      }
      voiceStopRequestedRef.current = true;
      if (voiceRestartTimerRef.current !== undefined) {
        window.clearTimeout(voiceRestartTimerRef.current);
        voiceRestartTimerRef.current = undefined;
      }
      setVoiceStatus("error");
      terminalRef.current?.write(`\r\n[Workbench voice] ${event.error ?? "Speech recognition failed"}\r\n`);
    };
    recognition.onend = () => {
      if (speechRecognitionRef.current === recognition) {
        speechRecognitionRef.current = undefined;
      }
      if (voiceStopRequestedRef.current) {
        setVoiceStatus((current) => (current === "unsupported" ? "unsupported" : "idle"));
        return;
      }
      setVoiceStatus("listening");
      voiceRestartTimerRef.current = window.setTimeout(() => {
        voiceRestartTimerRef.current = undefined;
        startVoiceRecognition(Recognition);
      }, 250);
    };

    try {
      recognition.start();
      setVoiceStatus("listening");
      terminalRef.current?.focus();
    } catch (error) {
      setVoiceStatus("error");
      terminalRef.current?.write(`\r\n[Workbench voice] ${error instanceof Error ? error.message : "Unable to start voice input"}\r\n`);
    }
  }

  function stopTerminal(): void {
    const socket = socketRef.current;
    if (!task || socket?.readyState !== WebSocket.OPEN) {
      return;
    }
    setStatus("stopping");
    socket.send(JSON.stringify({ taskId: task.id, type: "terminal.stop" }));
  }

  function clearTerminal(): void {
    terminalRef.current?.clear();
    onProjectionLinesChange?.([]);
    const socket = socketRef.current;
    if (task && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ taskId: task.id, type: "terminal.clear" }));
    }
  }

  function detachTerminal(): void {
    if (replaySettleTimerRef.current !== undefined) {
      window.clearTimeout(replaySettleTimerRef.current);
      replaySettleTimerRef.current = undefined;
    }
    suppressInputRef.current = false;
    socketRef.current?.close();
    socketRef.current = undefined;
    setAttached(false);
    setStatus("detached");
  }

  if (!task) {
    return <p className="empty">Select a session to open a terminal.</p>;
  }

  return (
    <div className="terminal-panel">
      <div className="terminal-toolbar">
        <div className="terminal-toolbar-copy">
          <strong>
            {linkedGemini
              ? `Gemini ${linkedGemini}`
              : linkedCodex
                ? `Codex ${linkedCodex}`
                : linkedClaude
                  ? `Claude ${linkedClaude}`
                  : activeCommand
                    ? activeCommand
                    : "CLI terminal"}
          </strong>
          <small>
            {linkedGemini
              ? "Resumes the bound native Gemini session."
              : linkedCodex
                ? "Resumes the bound native Codex session."
                : linkedClaude
                  ? "Resumes the bound native Claude Code session."
                  : task.worktreePath ?? "No worktree"}
          </small>
        </div>
        <span className={`terminal-status ${status}`}>{status}</span>
        <button
          className="secondary compact-button"
          disabled={!resolvedTerminalCommand(selectedCommand, customCommand, task)}
          onClick={() => connectTerminal(attached ? "terminal.restart" : "terminal.open")}
          type="button"
        >
          {attached ? "Restart" : activeCommand ? "Reattach" : "Attach"}
        </button>
        <button className="secondary compact-button" disabled={!terminalRef.current} onClick={clearTerminal} type="button">
          Clear
        </button>
        <button className="danger compact-button" disabled={!attached || !["running", "connecting", "stopping"].includes(status)} onClick={stopTerminal} type="button">
          Stop
        </button>
      </div>
      <div className="terminal-launch">
        {linkedGemini ? (
          <>
            <strong className="terminal-command-label">Session</strong>
            <p className="terminal-command-note" title={`gemini --resume ${linkedGemini}`}>
              gemini --resume {truncateMiddle(linkedGemini, 18)}
            </p>
          </>
        ) : linkedCodex ? (
          <>
            <strong className="terminal-command-label">Session</strong>
            <p className="terminal-command-note" title={`codex resume ${linkedCodex}`}>
              codex resume {truncateMiddle(linkedCodex, 18)}
            </p>
          </>
        ) : linkedClaude ? (
          <>
            <strong className="terminal-command-label">Session</strong>
            <p className="terminal-command-note" title={linkedClaudeCommand(task) ?? `claude --resume ${linkedClaude}`}>
              {task.agentSessionResumeMode === "resume" ? "claude --resume" : "claude --session-id"} {truncateMiddle(linkedClaude, 18)}
            </p>
          </>
        ) : waitingForGeminiSession ? (
          <>
            <strong className="terminal-command-label">Session</strong>
            <p className="terminal-command-note">Attach starts `gemini` once. After Gemini creates a native session id, Workbench links it and future attaches use resume.</p>
          </>
        ) : waitingForCodexSession ? (
          <>
            <strong className="terminal-command-label">Session</strong>
            <p className="terminal-command-note">Attach starts `codex` once. After Codex writes its native session metadata, Workbench links it and future attaches use resume.</p>
          </>
        ) : waitingForClaudeSession ? (
          <>
            <strong className="terminal-command-label">Session</strong>
            <p className="terminal-command-note">Attach starts `claude --session-id` with a fixed Workbench id. Future attaches use `claude --resume`.</p>
          </>
        ) : (
          <>
            <strong className="terminal-command-label">Command</strong>
            <select value={selectedCommand} onChange={(event) => setSelectedCommand(event.target.value)}>
              {terminalCommandOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {selectedCommand === "custom" ? (
              <input
                placeholder="custom command, e.g. gemini --model gemini-2.5-pro"
                value={customCommand}
                onChange={(event) => setCustomCommand(event.target.value)}
              />
            ) : (
              <p className="terminal-command-note">{resolvedTerminalCommand(selectedCommand, customCommand, task) || "Select a command to attach."}</p>
            )}
          </>
        )}
        {onToggleProjection ? (
          <button
            className="secondary compact-button"
            onClick={onToggleProjection}
            title={isProjected ? "Return terminal to the side panel" : "Show this terminal in the main workspace"}
            type="button"
          >
            {isProjected ? "Close split" : "Split"}
          </button>
        ) : null}
        <button
          className={`secondary compact-button terminal-voice-button ${voiceStatus === "listening" ? "listening" : ""}`}
          disabled={voiceStatus === "unsupported" || !terminalRef.current || socketRef.current?.readyState !== WebSocket.OPEN}
          onClick={toggleVoiceInput}
          title={
            voiceStatus === "unsupported"
              ? "Browser speech recognition is not available. Chrome/Edge over HTTPS or localhost usually works."
              : voiceStatus === "listening"
                ? "Stop voice input"
                : "Start browser voice input"
          }
          type="button"
        >
          {voiceStatus === "listening" ? "Stop voice" : "Voice"}
        </button>
        <button className="secondary compact-button" onClick={refitTerminal} type="button">
          Fit
        </button>
        <button className="secondary compact-button" disabled={!attached} onClick={detachTerminal} type="button">
          Detach
        </button>
        {clipboardStatus ? <small className="terminal-clipboard-status">{clipboardStatus}</small> : null}
        {claudeTrustPromptVisible ? (
          <button className="secondary compact-button" onClick={() => writeTerminalInput("\r")} type="button">
            Trust folder
          </button>
        ) : null}
      </div>
      <div
        className={`terminal-container ${isUploadingClipboardImage ? "uploading" : ""}`}
        onMouseDown={() => terminalRef.current?.focus()}
        ref={containerRef}
      />
    </div>
  );
}

export default TerminalPanel;

const terminalCommandOptions = [
  { label: "Gemini CLI", value: "gemini" },
  { label: "Claude Code", value: "claude" },
  { label: "OpenCode", value: "opencode" },
  { label: "Codex", value: "codex" },
  { label: "Custom", value: "custom" },
];

function resolvedTerminalCommand(selectedCommand: string, customCommand: string, task?: Task): string {
  const linkedResume = linkedGeminiResumeCommand(task);
  if (selectedCommand === "gemini" && linkedResume) {
    return linkedResume;
  }
  const linkedCodex = linkedCodexResumeCommand(task);
  if (selectedCommand === "codex" && linkedCodex) {
    return linkedCodex;
  }
  const linkedClaude = linkedClaudeResumeCommand(task);
  if (selectedCommand === "claude" && linkedClaude) {
    return linkedClaude;
  }
  return selectedCommand === "custom" ? customCommand.trim() : selectedCommand.trim();
}

function linkedGeminiResumeCommand(task?: Task): string | undefined {
  const sessionId = linkedGeminiSessionId(task);
  return sessionId ? `gemini --resume ${sessionId}` : undefined;
}

function linkedCodexResumeCommand(task?: Task): string | undefined {
  const sessionId = linkedCodexSessionId(task);
  return sessionId ? `codex resume ${sessionId}` : undefined;
}

function linkedClaudeResumeCommand(task?: Task): string | undefined {
  const sessionId = linkedClaudeSessionId(task);
  if (!sessionId) {
    return undefined;
  }
  return task?.agentSessionResumeMode === "resume" ? `claude --resume ${sessionId}` : `claude --session-id ${sessionId}`;
}

function linkedClaudeCommand(task?: Task): string | undefined {
  return linkedClaudeResumeCommand(task);
}

function linkedGeminiSessionId(task?: Task): string | undefined {
  if (!task?.agentSessionId) {
    return undefined;
  }
  if (task.backendId !== "gemini" && task.backendId !== "gemini-acp") {
    return undefined;
  }
  if (task.agentSessionKind === "native-cli" || (task.agentSessionKind === undefined && task.agentSessionOrigin === "imported")) {
    return task.agentSessionId;
  }
  return undefined;
}

function linkedCodexSessionId(task?: Task): string | undefined {
  if (!task?.agentSessionId) {
    return undefined;
  }
  if (task.backendId !== "codex") {
    return undefined;
  }
  if (task.agentSessionKind === "native-cli" || (task.agentSessionKind === undefined && task.agentSessionOrigin === "imported")) {
    return task.agentSessionId;
  }
  return undefined;
}

function linkedClaudeSessionId(task?: Task): string | undefined {
  if (!task?.agentSessionId) {
    return undefined;
  }
  if (task.backendId !== "claude") {
    return undefined;
  }
  if (task.agentSessionKind === "native-cli" || (task.agentSessionKind === undefined && task.agentSessionOrigin === "imported")) {
    return task.agentSessionId;
  }
  return undefined;
}

function defaultTerminalCommandForTask(task?: Task): string {
  return fixedTerminalCommandForTask(task) ?? "gemini";
}

function fixedTerminalCommandForTask(task?: Task): string | undefined {
  if (task?.backendId === "codex") {
    return "codex";
  }
  if (task?.backendId === "claude") {
    return "claude";
  }
  if (task?.backendId === "gemini" || task?.backendId === "gemini-acp") {
    return "gemini";
  }
  return undefined;
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  const side = Math.max(4, Math.floor((maxLength - 1) / 2));
  return `${value.slice(0, side)}…${value.slice(-side)}`;
}

function normalizeTerminalOutput(data: string, command: string): string {
  return isGeminiCliCommand(command) ? removeGeminiBackgroundColors(data) : data;
}

function projectionLinesFromTerminal(terminal: Terminal): string[] {
  const buffer = terminal.buffer.active;
  const start = Math.max(0, buffer.length - 700);
  const lines: string[] = [];
  let previousBlank = false;

  for (let index = start; index < buffer.length; index += 1) {
    const line = buffer.getLine(index)?.translateToString(true).replace(/\s+$/g, "") ?? "";
    if (isTerminalProjectionChromeLine(line)) {
      continue;
    }
    const blank = line.trim().length === 0;
    if (blank && previousBlank) {
      continue;
    }
    lines.push(line);
    previousBlank = blank;
  }

  while (lines.length > 0 && !lines[0]?.trim()) {
    lines.shift();
  }
  return lines.slice(-500);
}

function isTerminalProjectionChromeLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }
  if (/^[─━═▄▀\s]+$/.test(trimmed)) {
    return true;
  }
  if (trimmed.includes("? for shortcuts")) {
    return true;
  }
  if (trimmed.includes("Shift+Tab to accept edits")) {
    return true;
  }
  if (trimmed.includes("Type your message or @path/to/file")) {
    return true;
  }
  if (/^\d+\s+GEMINI\.md files?/.test(trimmed)) {
    return true;
  }
  if (/\bworkspace\b/.test(trimmed) && /\bbranch\b/.test(trimmed) && /\bsandbox\b/.test(trimmed)) {
    return true;
  }
  if (trimmed.startsWith("~/.agent-") && trimmed.includes(" no sandbox ")) {
    return true;
  }
  return false;
}

function removeGeminiBackgroundColors(data: string): string {
  return data.replace(/\x1b\[([0-9;]*)m/g, (sequence, parameters: string) => {
    const normalized = removeSgrBackgroundParameters(parameters);
    return normalized === parameters ? sequence : `\x1b[${normalized || "49"}m`;
  });
}

function removeSgrBackgroundParameters(parameters: string): string {
  if (!parameters) {
    return parameters;
  }
  const parts = parameters.split(";");
  const kept: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const code = parts[index] ?? "";
    const mode = parts[index + 1];
    if (code === "48" && mode === "2") {
      index += 4;
      continue;
    }
    if (code === "48" && mode === "5") {
      index += 2;
      continue;
    }
    if ((Number(code) >= 40 && Number(code) <= 47) || (Number(code) >= 100 && Number(code) <= 107)) {
      continue;
    }
    kept.push(code);
  }
  return kept.join(";");
}

function isGeminiCliCommand(command: string): boolean {
  return command === "gemini" || /^gemini\s+--resume(?:=|\s+)/.test(command);
}

function isClaudeCliCommand(command: string): boolean {
  return command === "claude" || /^claude\s+(--resume|--session-id|-r)(?:=|\s|$)/.test(command);
}

function detectClaudeTrustPrompt(data: string): boolean {
  return data.includes("Quick safety check") || data.includes("Yes, I trust this folder");
}

function isGeminiWorkbenchSession(task?: Task): boolean {
  return task?.backendId === "gemini" || task?.backendId === "gemini-acp";
}

function isCodexWorkbenchSession(task?: Task): boolean {
  return task?.backendId === "codex";
}

function isClaudeWorkbenchSession(task?: Task): boolean {
  return task?.backendId === "claude";
}

function installTerminalPasteListener(container: HTMLDivElement, onPaste: (event: ClipboardEvent) => void): () => void {
  const listener = (event: ClipboardEvent) => {
    const target = event.target;
    if (target instanceof Node && container.contains(target)) {
      onPaste(event);
    }
  };
  container.addEventListener("paste", listener, true);
  document.addEventListener("paste", listener, true);
  return () => {
    container.removeEventListener("paste", listener, true);
    document.removeEventListener("paste", listener, true);
  };
}

function clipboardImageFile(clipboardData: DataTransfer): File | undefined {
  for (const item of Array.from(clipboardData.items)) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      return item.getAsFile() ?? undefined;
    }
  }
  return Array.from(clipboardData.files).find((file) => file.type.startsWith("image/"));
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Unable to read pasted image."));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const commaIndex = result.indexOf(",");
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

function errorMessageFromResponse(text: string, fallback: string): string {
  if (!text.trim()) {
    return fallback;
  }
  try {
    const payload = JSON.parse(text) as { error?: unknown; hint?: unknown; message?: unknown };
    if (typeof payload.message === "string" && payload.message.trim()) {
      return typeof payload.hint === "string" && payload.hint.trim()
        ? `${payload.message}\n\n${payload.hint}`
        : payload.message;
    }
    if (typeof payload.error === "string" && payload.error.trim()) {
      return payload.error;
    }
  } catch {
    return text;
  }
  return text;
}

function speechRecognitionConstructor(): SpeechRecognitionConstructor | undefined {
  const speechWindow = window as Window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
}

function terminalCommandStorageKey(taskId: string): string {
  return `agent-workbench-terminal-command:${taskId}`;
}
