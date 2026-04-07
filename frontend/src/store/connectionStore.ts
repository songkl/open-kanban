import { create } from 'zustand';

interface ConnectionState {
  wsStatus: 'connected' | 'disconnected' | 'failed';
  reconnectCount: number;
  offlineQueue: Array<{ action: string; data: unknown; timestamp: number }>;
  isProcessingQueue: boolean;
  lastLocalUpdate: number;
  REFRESH_DEBOUNCE_MS: number;

  setWsStatus: (status: 'connected' | 'disconnected' | 'failed') => void;
  setReconnectCount: (count: number) => void;
  addToOfflineQueue: (action: string, data: unknown) => void;
  setIsProcessingQueue: (processing: boolean) => void;
  setLastLocalUpdate: (timestamp: number) => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  wsStatus: 'disconnected',
  reconnectCount: 0,
  offlineQueue: [],
  isProcessingQueue: false,
  lastLocalUpdate: 0,
  REFRESH_DEBOUNCE_MS: 1000,

  setWsStatus: (status) => set({ wsStatus: status }),
  setReconnectCount: (count) => set({ reconnectCount: count }),
  addToOfflineQueue: (action, data) => set((state) => ({
    offlineQueue: [...state.offlineQueue, { action, data, timestamp: Date.now() }]
  })),
  setIsProcessingQueue: (processing) => set({ isProcessingQueue: processing }),
  setLastLocalUpdate: (timestamp) => set({ lastLocalUpdate: timestamp }),
}));