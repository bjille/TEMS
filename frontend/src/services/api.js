import axios from 'axios';

const baseURL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

export const api = axios.create({ baseURL: `${baseURL}/api` });

let accessToken = null;
let refreshToken = null;
let onTokensRefreshed = null;

export function setTokens(tokens) {
  accessToken = tokens?.accessToken || null;
  refreshToken = tokens?.refreshToken || null;
  if (accessToken) localStorage.setItem('tems.accessToken', accessToken);
  else localStorage.removeItem('tems.accessToken');
  if (refreshToken) localStorage.setItem('tems.refreshToken', refreshToken);
  else localStorage.removeItem('tems.refreshToken');
}

export function loadStoredTokens() {
  accessToken = localStorage.getItem('tems.accessToken');
  refreshToken = localStorage.getItem('tems.refreshToken');
  return { accessToken, refreshToken };
}

export function getAccessToken() {
  return accessToken;
}

export function onTokensRefresh(callback) {
  onTokensRefreshed = callback;
}

api.interceptors.request.use((config) => {
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  return config;
});

let refreshPromise = null;

api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config;
    if (error.response?.status === 401 && refreshToken && !original._retry) {
      original._retry = true;
      try {
        refreshPromise =
          refreshPromise ||
          axios.post(`${baseURL}/api/auth/refresh`, { refreshToken }).finally(() => {
            refreshPromise = null;
          });
        const { data } = await refreshPromise;
        setTokens(data);
        onTokensRefreshed?.(data);
        original.headers.Authorization = `Bearer ${data.accessToken}`;
        return api(original);
      } catch (refreshErr) {
        setTokens(null);
        onTokensRefreshed?.(null);
        return Promise.reject(refreshErr);
      }
    }
    return Promise.reject(error);
  }
);
