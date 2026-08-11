import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { api, setTokens, loadStoredTokens, onTokensRefresh } from '../../services/api';

export const login = createAsyncThunk('auth/login', async ({ email, password }, { rejectWithValue }) => {
  try {
    const { data } = await api.post('/auth/login', { email, password });
    setTokens(data);
    return data;
  } catch (err) {
    return rejectWithValue(err.response?.data?.error?.message || 'Login mislukt');
  }
});

export const fetchMe = createAsyncThunk('auth/fetchMe', async (_, { rejectWithValue }) => {
  try {
    const { data } = await api.get('/auth/me');
    return data;
  } catch (err) {
    return rejectWithValue(err.response?.data?.error?.message || 'Sessie ongeldig');
  }
});

const stored = loadStoredTokens();

const authSlice = createSlice({
  name: 'auth',
  initialState: {
    user: null,
    accessToken: stored.accessToken || null,
    status: 'idle', // idle | loading | authenticated | error
    error: null,
  },
  reducers: {
    logout(state) {
      setTokens(null);
      state.user = null;
      state.accessToken = null;
      state.status = 'idle';
    },
    tokensCleared(state) {
      state.user = null;
      state.accessToken = null;
      state.status = 'idle';
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(login.pending, (state) => {
        state.status = 'loading';
        state.error = null;
      })
      .addCase(login.fulfilled, (state, action) => {
        state.status = 'authenticated';
        state.user = action.payload.user;
        state.accessToken = action.payload.accessToken;
      })
      .addCase(login.rejected, (state, action) => {
        state.status = 'error';
        state.error = action.payload;
      })
      .addCase(fetchMe.pending, (state) => {
        state.status = 'loading';
      })
      .addCase(fetchMe.fulfilled, (state, action) => {
        state.status = 'authenticated';
        state.user = action.payload;
      })
      .addCase(fetchMe.rejected, (state) => {
        state.status = 'idle';
        state.user = null;
        state.accessToken = null;
      });
  },
});

onTokensRefresh((tokens) => {
  if (!tokens) {
    // handled by fetchMe rejection path / logout on next auth check
  }
});

export const { logout, tokensCleared } = authSlice.actions;
export const selectAuth = (state) => state.auth;
export default authSlice.reducer;
