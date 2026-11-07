// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
import type { Waiting } from './fronta'

export {}

declare module 'orca' {
  interface PluginRequests {
    /** The windows waiting now, and why the list may be incomplete. */
    'fronta.get': { output: { waiting: Waiting[]; note: string } }
    /** Your answer to one window: a button (typed false) or your own words, one per part. */
    'fronta.answer': {
      input: { id: string; askId: string; picks: { text: string; typed: boolean }[] }
      output: { ok: boolean; reason?: string }
    }
    /** Shows the window's workspace in Orca. */
    'fronta.open': { input: { workspaceId: string }; output: { ok: boolean } }
  }
  interface PluginPanelEvents {
    /** Posted to open panels whenever the list changes. */
    'fronta.changed': { waiting: Waiting[]; note: string }
  }
}
