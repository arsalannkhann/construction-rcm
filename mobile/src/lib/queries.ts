/**
 * Reads from the server, cached in memory only (never on disk) and keyed by
 * organisation, so a response from one organisation can never answer a
 * question asked in another.
 */
import { focusManager, onlineManager, QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Network from 'expo-network';
import { AppState, Platform } from 'react-native';
import { api, ApiError, type ContractOption, type Detail, type Home, type Notification, type ProjectDetail, type ProjectRow, type Row } from './api';
import { useAuth } from './auth';

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
        refetchOnReconnect: true,
      },
      mutations: { retry: false },
    },
  });
}

/** Refetch when the app comes back to the foreground, and pause while offline. */
export function wireQueryLifecycle(): () => void {
  const appSub = AppState.addEventListener('change', (s) => {
    if (Platform.OS !== 'web') focusManager.setFocused(s === 'active');
  });
  const netSub = Network.addNetworkStateListener((state) => onlineManager.setOnline(state.isConnected !== false));
  return () => {
    appSub.remove();
    netSub.remove();
  };
}

function useOrgKey(): string {
  const { state } = useAuth();
  return state.status === 'signed_in' ? `${state.profile.userId}:${state.profile.orgId ?? 'none'}` : 'signed-out';
}

function useEnabled(): boolean {
  const { state, locked } = useAuth();
  return state.status === 'signed_in' && !!state.profile.orgId && !locked;
}

export function useHome() {
  const org = useOrgKey();
  return useQuery({ queryKey: [org, 'home'], queryFn: () => api<Home>('/api/mobile/home'), enabled: useEnabled() });
}

export type BillingView = 'attention' | 'open' | 'decided' | 'mine';

export function useApplications(view: BillingView) {
  const org = useOrgKey();
  return useQuery({ queryKey: [org, 'applications', view], queryFn: () => api<{ items: Row[] }>(`/api/mobile/applications?view=${view}`).then((r) => r.items), enabled: useEnabled() });
}

export function useApplication(id: string | undefined) {
  const org = useOrgKey();
  return useQuery({
    queryKey: [org, 'application', id],
    queryFn: () => api<Detail>(`/api/mobile/applications/${id}`),
    enabled: useEnabled() && !!id,
    // While the package is being read, look again every few seconds.
    refetchInterval: (query) => (query.state.data?.status === 'processing' ? 5_000 : false),
  });
}

export function useProjects() {
  const org = useOrgKey();
  return useQuery({ queryKey: [org, 'projects'], queryFn: () => api<{ items: ProjectRow[] }>('/api/mobile/projects').then((r) => r.items), enabled: useEnabled() });
}

export function useProject(id: string | undefined) {
  const org = useOrgKey();
  return useQuery({ queryKey: [org, 'project', id], queryFn: () => api<ProjectDetail>(`/api/mobile/projects/${id}`), enabled: useEnabled() && !!id });
}

export function useContracts() {
  const org = useOrgKey();
  return useQuery({ queryKey: [org, 'contracts'], queryFn: () => api<{ items: ContractOption[] }>('/api/mobile/contracts').then((r) => r.items), enabled: useEnabled(), staleTime: 5 * 60_000 });
}

export function useNotifications() {
  const org = useOrgKey();
  return useQuery({ queryKey: [org, 'notifications'], queryFn: () => api<{ unread: number; items: Notification[] }>('/api/mobile/notifications'), enabled: useEnabled() });
}

/** After a change, everything about this organisation is read again. */
export function useInvalidate() {
  const qc = useQueryClient();
  const org = useOrgKey();
  return () => qc.invalidateQueries({ queryKey: [org] });
}

export function useMarkRead() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (ids?: string[]) => api('/api/mobile/notifications', { method: 'POST', body: ids ? { ids } : {} }), onSuccess: invalidate });
}
