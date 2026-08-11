import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { api } from '../../services/api';

export const fetchUsers = createAsyncThunk('adminUsers/fetchAll', async (_, { rejectWithValue }) => {
  try {
    const { data } = await api.get('/admin/users');
    return data;
  } catch (err) {
    return rejectWithValue(err.response?.data?.error?.message || 'Kon gebruikers niet laden');
  }
});

export const createUser = createAsyncThunk(
  'adminUsers/create',
  async (payload, { rejectWithValue }) => {
    try {
      const { data } = await api.post('/admin/users', payload);
      return data;
    } catch (err) {
      return rejectWithValue(err.response?.data?.error?.message || 'Aanmaken mislukt');
    }
  }
);

export const updateUser = createAsyncThunk(
  'adminUsers/update',
  async ({ id, ...payload }, { rejectWithValue }) => {
    try {
      const { data } = await api.patch(`/admin/users/${id}`, payload);
      return data;
    } catch (err) {
      return rejectWithValue(err.response?.data?.error?.message || 'Bijwerken mislukt');
    }
  }
);

export const deleteUser = createAsyncThunk(
  'adminUsers/delete',
  async (id, { rejectWithValue }) => {
    try {
      await api.delete(`/admin/users/${id}`);
      return id;
    } catch (err) {
      return rejectWithValue(err.response?.data?.error?.message || 'Verwijderen mislukt');
    }
  }
);

const adminUsersSlice = createSlice({
  name: 'adminUsers',
  initialState: { items: [], status: 'idle', error: null },
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchUsers.pending, (state) => {
        state.status = 'loading';
      })
      .addCase(fetchUsers.fulfilled, (state, action) => {
        state.status = 'succeeded';
        state.items = action.payload;
      })
      .addCase(fetchUsers.rejected, (state, action) => {
        state.status = 'error';
        state.error = action.payload;
      })
      .addCase(createUser.fulfilled, (state, action) => {
        state.items.unshift(action.payload);
      })
      .addCase(updateUser.fulfilled, (state, action) => {
        const idx = state.items.findIndex((u) => (u._id || u.id) === action.payload.id);
        if (idx !== -1) state.items[idx] = { ...state.items[idx], ...action.payload };
      })
      .addCase(deleteUser.fulfilled, (state, action) => {
        state.items = state.items.filter((u) => (u._id || u.id) !== action.payload);
      });
  },
});

export const selectAllUsers = (state) => state.adminUsers.items;
export default adminUsersSlice.reducer;
