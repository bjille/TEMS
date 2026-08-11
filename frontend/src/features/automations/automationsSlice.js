import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { api } from '../../services/api';

export const fetchAutomations = createAsyncThunk(
  'automations/fetchAll',
  async (woningId, { rejectWithValue }) => {
    try {
      const { data } = await api.get(`/woningen/${woningId}/automations`);
      return { woningId, automations: data };
    } catch (err) {
      return rejectWithValue(err.response?.data?.error?.message || 'Kon automatiseringen niet laden');
    }
  }
);

export const createAutomation = createAsyncThunk(
  'automations/create',
  async ({ woningId, ...payload }, { rejectWithValue }) => {
    try {
      const { data } = await api.post(`/woningen/${woningId}/automations`, payload);
      return { woningId, automation: data };
    } catch (err) {
      return rejectWithValue(err.response?.data?.error?.message || 'Aanmaken mislukt');
    }
  }
);

export const updateAutomation = createAsyncThunk(
  'automations/update',
  async ({ woningId, automationId, ...payload }, { rejectWithValue }) => {
    try {
      const { data } = await api.patch(`/woningen/${woningId}/automations/${automationId}`, payload);
      return { woningId, automation: data };
    } catch (err) {
      return rejectWithValue(err.response?.data?.error?.message || 'Bijwerken mislukt');
    }
  }
);

export const deleteAutomation = createAsyncThunk(
  'automations/delete',
  async ({ woningId, automationId }, { rejectWithValue }) => {
    try {
      await api.delete(`/woningen/${woningId}/automations/${automationId}`);
      return { woningId, automationId };
    } catch (err) {
      return rejectWithValue(err.response?.data?.error?.message || 'Verwijderen mislukt');
    }
  }
);

const automationsSlice = createSlice({
  name: 'automations',
  initialState: {
    byWoning: {},
    status: 'idle',
    error: null,
  },
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchAutomations.pending, (state) => {
        state.status = 'loading';
      })
      .addCase(fetchAutomations.fulfilled, (state, action) => {
        state.status = 'succeeded';
        state.byWoning[action.payload.woningId] = action.payload.automations;
      })
      .addCase(fetchAutomations.rejected, (state, action) => {
        state.status = 'error';
        state.error = action.payload;
      })
      .addCase(createAutomation.fulfilled, (state, action) => {
        const { woningId, automation } = action.payload;
        if (!state.byWoning[woningId]) state.byWoning[woningId] = [];
        state.byWoning[woningId].push(automation);
      })
      .addCase(updateAutomation.fulfilled, (state, action) => {
        const { woningId, automation } = action.payload;
        const list = state.byWoning[woningId] || [];
        const idx = list.findIndex((a) => a._id === automation._id);
        if (idx !== -1) list[idx] = automation;
      })
      .addCase(deleteAutomation.fulfilled, (state, action) => {
        const { woningId, automationId } = action.payload;
        state.byWoning[woningId] = (state.byWoning[woningId] || []).filter(
          (a) => a._id !== automationId
        );
      });
  },
});

export const selectAutomationsForWoning = (woningId) => (state) =>
  state.automations.byWoning[woningId] || [];
export default automationsSlice.reducer;
