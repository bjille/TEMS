import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { api } from '../../services/api';

export const fetchParameterCategories = createAsyncThunk(
  'parameterCategories/fetchAll',
  async (_, { rejectWithValue }) => {
    try {
      const { data } = await api.get('/parameter-categories');
      return data;
    } catch (err) {
      return rejectWithValue(err.response?.data?.error?.message || 'Kon categorieën niet laden');
    }
  }
);

export const createParameterCategory = createAsyncThunk(
  'parameterCategories/create',
  async (name, { rejectWithValue }) => {
    try {
      const { data } = await api.post('/parameter-categories', { name });
      return data;
    } catch (err) {
      return rejectWithValue(err.response?.data?.error?.message || 'Aanmaken mislukt');
    }
  }
);

export const updateParameterCategory = createAsyncThunk(
  'parameterCategories/update',
  async ({ id, name }, { rejectWithValue }) => {
    try {
      const { data } = await api.patch(`/parameter-categories/${id}`, { name });
      return data;
    } catch (err) {
      return rejectWithValue(err.response?.data?.error?.message || 'Bijwerken mislukt');
    }
  }
);

export const deleteParameterCategory = createAsyncThunk(
  'parameterCategories/delete',
  async (id, { rejectWithValue }) => {
    try {
      await api.delete(`/parameter-categories/${id}`);
      return id;
    } catch (err) {
      return rejectWithValue(err.response?.data?.error?.message || 'Verwijderen mislukt');
    }
  }
);

const parameterCategoriesSlice = createSlice({
  name: 'parameterCategories',
  initialState: { items: [], status: 'idle', error: null },
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchParameterCategories.pending, (state) => {
        state.status = 'loading';
      })
      .addCase(fetchParameterCategories.fulfilled, (state, action) => {
        state.status = 'succeeded';
        state.items = action.payload;
      })
      .addCase(fetchParameterCategories.rejected, (state, action) => {
        state.status = 'error';
        state.error = action.payload;
      })
      .addCase(createParameterCategory.fulfilled, (state, action) => {
        state.items.push(action.payload);
        state.items.sort((a, b) => a.name.localeCompare(b.name));
      })
      .addCase(updateParameterCategory.fulfilled, (state, action) => {
        const idx = state.items.findIndex((c) => c._id === action.payload._id);
        if (idx !== -1) state.items[idx] = action.payload;
        state.items.sort((a, b) => a.name.localeCompare(b.name));
      })
      .addCase(deleteParameterCategory.fulfilled, (state, action) => {
        state.items = state.items.filter((c) => c._id !== action.payload);
      });
  },
});

export const selectParameterCategories = (state) => state.parameterCategories.items;
export default parameterCategoriesSlice.reducer;
