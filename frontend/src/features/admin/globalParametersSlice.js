import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { api } from '../../services/api';

export const fetchGlobalParameters = createAsyncThunk(
  'globalParameters/fetchAll',
  async (_, { rejectWithValue }) => {
    try {
      const { data } = await api.get('/admin/global-parameters');
      return data;
    } catch (err) {
      return rejectWithValue(err.response?.data?.error?.message || 'Kon globale parameters niet laden');
    }
  }
);

export const createGlobalParameter = createAsyncThunk(
  'globalParameters/create',
  async (payload, { rejectWithValue }) => {
    try {
      const { data } = await api.post('/admin/global-parameters', payload);
      return data;
    } catch (err) {
      return rejectWithValue(err.response?.data?.error?.message || 'Aanmaken mislukt');
    }
  }
);

export const updateGlobalParameter = createAsyncThunk(
  'globalParameters/update',
  async ({ id, ...payload }, { rejectWithValue }) => {
    try {
      const { data } = await api.patch(`/admin/global-parameters/${id}`, payload);
      return data;
    } catch (err) {
      return rejectWithValue(err.response?.data?.error?.message || 'Bijwerken mislukt');
    }
  }
);

export const deleteGlobalParameter = createAsyncThunk(
  'globalParameters/delete',
  async (id, { rejectWithValue }) => {
    try {
      await api.delete(`/admin/global-parameters/${id}`);
      return id;
    } catch (err) {
      return rejectWithValue(err.response?.data?.error?.message || 'Verwijderen mislukt');
    }
  }
);

const globalParametersSlice = createSlice({
  name: 'globalParameters',
  initialState: { items: [], status: 'idle', error: null },
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchGlobalParameters.pending, (state) => {
        state.status = 'loading';
      })
      .addCase(fetchGlobalParameters.fulfilled, (state, action) => {
        state.status = 'succeeded';
        state.items = action.payload;
      })
      .addCase(fetchGlobalParameters.rejected, (state, action) => {
        state.status = 'error';
        state.error = action.payload;
      })
      .addCase(createGlobalParameter.fulfilled, (state, action) => {
        state.items.push(action.payload);
      })
      .addCase(updateGlobalParameter.fulfilled, (state, action) => {
        const idx = state.items.findIndex((p) => p._id === action.payload._id);
        if (idx !== -1) state.items[idx] = action.payload;
      })
      .addCase(deleteGlobalParameter.fulfilled, (state, action) => {
        state.items = state.items.filter((p) => p._id !== action.payload);
      });
  },
});

export const selectAllGlobalParameters = (state) => state.globalParameters.items;
export default globalParametersSlice.reducer;
