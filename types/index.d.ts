export type Row = {
  id: string
  title: string
  link: string
  isRunning: boolean
  lastActivityAt: string
  waiting: boolean
  snippet: string
  unread: boolean
  rc: boolean
  // The window's Remote Control link (claude://claude.ai/code/session_…), '' without Remote Control:
  // it opens the window from the other PC.
  rcLink: string
  // The window's last model reply (lastAssistantUuid), '' when unknown: a deferred window
  // comes back once it changes, i.e. once you write into it (a compact leaves it alone).
  turn: string
  deferred: boolean
  // This PC's waiting windows: the question as the window asked it, with the replies its buttons send.
  question?: { text: string; context: string; options: string[]; parts?: { text: string; options: string[] }[] }
  // The question's exact id when the window reported it itself (0.9): Centrála's plugin answers it.
  askId?: string
  // The window has asked for a permission a while: what for (only shown, never answered remotely).
  approval?: string
}

// The windows of another of your PCs, as that PC last sent them through your server.
export type RemotePc = { pc: string; at: number; rows: Row[] }

declare module 'claude-code' {
  interface PluginState {
    // open: which folded sections are open, by key; bar: whether the state bar is drawn.
    okna: { rows: Row[]; info: string; remote: RemotePc[]; sync: string; open: Record<string, boolean>; bar: boolean }
  }
}
