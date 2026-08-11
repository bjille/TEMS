import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { api } from '../../services/api';

export const fetchWoningen = createAsyncThunk('woningen/fetchAll', async (_, { rejectWithValue }) => {
  try {
    const { data } = await api.get('/woningen');
    return data;
  } catch (err) {
    return rejectWithValue(err.response?.data?.error?.message || 'Kon woningen niet laden');
  }
});

export const createWoning = createAsyncThunk(
  'woningen/create',
  async (payload, { rejectWithValue }) => {
    try {
      const { data } = await api.post('/woningen', payload);
      return data;
    } catch (err) {
      return rejectWithValue(err.response?.data?.error?.message || 'Aanmaken mislukt');
    }
  }
);

export const updateWoning = createAsyncThunk(
  'woningen/update',
  async ({ id, ...payload }, { rejectWithValue }) => {
    try {
      const { data } = await api.patch(`/woningen/${id}`, payload);
      return data;
    } catch (err) {
      return rejectWithValue(err.response?.data?.error?.message || 'Bijwerken mislukt');
    }
  }
);

export const deleteWoning = createAsyncThunk(
  'woningen/delete',
  async (id, { rejectWithValue }) => {
    try {
      await api.delete(`/woningen/${id}`);
      return id;
    } catch (err) {
      return rejectWithValue(err.response?.data?.error?.message || 'Verwijderen mislukt');
    }
  }
);

const woningenSlice = createSlice({
  name: 'woningen',
  // selectedId: undefined = not decided yet, null = "alle installaties" (overview), id = one specific woning.
  initialState: {
    items: [],
    selectedId: undefined,
    status: 'idle',
    error: null,
  },
  reducers: {
    selectWoning(state, action) {
      state.selectedId = action.payload || null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchWoningen.pending, (state) => {
        state.status = 'loading';
      })
      .addCase(fetchWoningen.fulfilled, (state, action) => {
        state.status = 'succeeded';
        state.items = action.payload;
        if (state.selectedId === undefined) {
          // Superadmins land on the cross-installation overview by default;
          // regular users (usually one woning) go straight to their own.
          const isSuperadmin = action.payload[0]?.role === 'superadmin';
          state.selectedId =
            !isSuperadmin && action.payload.length > 0 ? action.payload[0]._id : null;
        }
      })
      .addCase(fetchWoningen.rejected, (state, action) => {
        state.status = 'error';
        state.error = action.payload;
      })
      .addCase(createWoning.fulfilled, (state, action) => {
        state.items.push(action.payload);
      })
      .addCase(updateWoning.fulfilled, (state, action) => {
        const idx = state.items.findIndex((w) => w._id === action.payload._id);
        if (idx !== -1) state.items[idx] = action.payload;
      })
      .addCase(deleteWoning.fulfilled, (state, action) => {
        state.items = state.items.filter((w) => w._id !== action.payload);
        if (state.selectedId === action.payload) {
          state.selectedId = state.items[0]?._id || null;
        }
      });
  },
});

export const { selectWoning } = woningenSlice.actions;
export const selectWoningen = (state) => state.woningen.items;
export const selectSelectedWoningId = (state) => state.woningen.selectedId;
export default woningenSlice.reducer;
