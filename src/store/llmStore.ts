import { createStore } from 'zustand/vanilla';
import type { LLMConfig } from '../lib/llm/types';
import { llmService } from '../lib/llm/LLMProvider';

interface LLMStore {
  config: LLMConfig | null;
  isInitialized: boolean;
  isInitializing: boolean;
  error: string | null;
  setConfig: (config: LLMConfig) => Promise<void>;
  reset: () => void;
}

const store = createStore<LLMStore>((set) => ({
  config: null,
  isInitialized: false,
  isInitializing: false,
  error: null,

  setConfig: async (config: LLMConfig) => {
    set({ isInitializing: true, error: null });
    try {
      await llmService.initialize(config);
      set({ config, isInitialized: true, isInitializing: false });
      localStorage.setItem('llm-config', JSON.stringify(config));
    } catch (err) {
      set({ error: String(err), isInitializing: false });
    }
  },

  reset: () => {
    set({ config: null, isInitialized: false, error: null });
    localStorage.removeItem('llm-config');
  },
}));

export const useLLMStore = {
  getState: () => store.getState(),
  subscribe: store.subscribe,
};
