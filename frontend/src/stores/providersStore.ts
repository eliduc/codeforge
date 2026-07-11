import { create } from 'zustand'
import type { ProviderInfo } from '../types'
import {
  getLLMProviders,
  refreshModels,
  checkModelUpdates,
  acknowledgeModelUpdates,
} from '../services/api'
import type { ModelUpdatesResponse } from '../services/api'

interface ProvidersState {
  /** All providers (including unconfigured) */
  allProviders: ProviderInfo[]
  /** Configured providers only (filtered) — convenience for agent selectors */
  providers: ProviderInfo[]
  /** True if at least one provider has a valid API key configured */
  hasAnyConfigured: boolean
  loading: boolean
  loaded: boolean
  error: string | null

  /** Fetch providers from API (only if not already loaded, unless force=true) */
  fetchProviders: (force?: boolean) => Promise<void>

  /** Refresh models from provider APIs, then re-fetch provider list */
  refreshAllModels: () => Promise<{ success: boolean; error?: string }>

  /** КАО#R6-models — background check for newly-available / announced models */
  checkModelUpdates: () => Promise<ModelUpdatesResponse | null>
  /** Mark the current model lineup as seen (dismiss the notification) */
  acknowledgeModels: () => Promise<void>
}

export const useProvidersStore = create<ProvidersState>((set, get) => ({
  allProviders: [],
  providers: [],
  hasAnyConfigured: false,
  loading: false,
  loaded: false,
  error: null,

  fetchProviders: async (force = false) => {
    const state = get()
    if (state.loaded && !force) return
    if (state.loading) return

    set({ loading: true, error: null })
    try {
      const data = await getLLMProviders()
      const all = data.providers
      const configured = all.filter((p: ProviderInfo) => p.configured)
      const avail = configured.length > 0 ? configured : all
      const hasAny = configured.length > 0
      set({ allProviders: all, providers: avail, hasAnyConfigured: hasAny, loading: false, loaded: true })
    } catch (err) {
      set({ loading: false, error: String(err) })
    }
  },

  refreshAllModels: async () => {
    try {
      const result = await refreshModels()
      if (result.success) {
        set({ loaded: false })
        await get().fetchProviders(true)
        return { success: true }
      } else {
        return { success: false, error: 'Refresh failed' }
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },

  checkModelUpdates: async () => {
    try {
      return await checkModelUpdates()
    } catch {
      // Best-effort background check — never surface an error to the user.
      return null
    }
  },

  acknowledgeModels: async () => {
    try {
      await acknowledgeModelUpdates()
    } catch {
      /* ignore — acknowledgement is best-effort */
    }
  },
}))
