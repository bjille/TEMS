import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { api } from '../../services/api';

export const fetchGlobalAutomations = createAsyncThunk(
  'globalAutomations/fetchAll',
  async (_, { rejectWithValue }) => {
    try {
      const { data } = await api.get('/admin/global-automations');
      return data;
    } catch (err) {
      return rejectWithValue(err.response?.data?.error?.message || 'Kon automatiseringen niet laden');
    }
  }
);

export const createGlobalAutomation = createAsyncThunk(
  'globalAutomations/create',
  async (payload, { rejectWithValue }) => {
    try {
      const { data } = await api.post('/admin/global-automations', payload);
      return data;
    } catch (err) {
      return rejectWithValue(err.response?.data?.error?.message || 'Aanmaken mislukt');
    }
  }
);

export const updateGlobalAutomation = createAsyncThunk(
  'globalAutomations/update',
  async ({ id, ...payload }, { rejectWithValue }) => {
    try {
      const { data } = await api.patch(`/admin/global-automations/${id}`, payload);
      return data;
    } catch (err) {
      return rejectWithValue(err.response?.data?.error?.message || 'Bijwerken mislukt');
    }
  }
);

export const deleteGlobalAutomation = createAsyncThunk(
  'globalAutomations/delete',
  async (id, { rejectWithValue }) => {
    try {
      await api.delete(`/admin/global-automations/${id}`);
      return id;
    } catch (err) {
      return rejectWithValue(err.response?.data?.error?.message || 'Verwijderen mislukt');
    }
  }
);

const globalAutomationsSlice = createSlice({
  name: 'globalAutomations',
  initialState: { items: [], status: 'idle', error: null },
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchGlobalAutomations.pending, (state) => {
        state.status = 'loading';
      })
      .addCase(fetchGlobalAutomations.fulfilled, (state, action) => {
        state.status = 'succeeded';
        state.items = action.payload;
      })
      .addCase(fetchGlobalAutomations.rejected, (state, action) => {
        state.status = 'error';
        state.error = action.payload;
      })
      .addCase(createGlobalAutomation.fulfilled, (state, action) => {
        state.items.push(action.payload);
      })
      .addCase(updateGlobalAutomation.fulfilled, (state, action) => {
        const idx = state.items.findIndex((a) => a._id === action.payload._id);
        if (idx !== -1) state.items[idx] = action.payload;
      })
      .addCase(deleteGlobalAutomation.fulfilled, (state, action) => {
        state.items = state.items.filter((a) => a._id !== action.payload);
      });
  },
});

export const selectAllGlobalAutomations = (state) => state.globalAutomations.items;
export default globalAutomationsSlice.reducer;
