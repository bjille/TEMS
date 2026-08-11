import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { api } from '../../services/api';

export const fetchParameters = createAsyncThunk(
  'parameters/fetchAll',
  async (woningId, { rejectWithValue }) => {
    try {
      const { data } = await api.get(`/woningen/${woningId}/parameters`);
      return { woningId, parameters: data };
    } catch (err) {
      return rejectWithValue(err.response?.data?.error?.message || 'Kon parameters niet laden');
    }
  }
);

export const createParameter = createAsyncThunk(
  'parameters/create',
  async ({ woningId, ...payload }, { rejectWithValue }) => {
    try {
      const { data } = await api.post(`/woningen/${woningId}/parameters`, payload);
      return { ...data, latest: null };
    } catch (err) {
      return rejectWithValue(err.response?.data?.error?.message || 'Aanmaken mislukt');
    }
  }
);

export const updateParameter = createAsyncThunk(
  'parameters/update',
  async ({ woningId, parameterId, ...payload }, { rejectWithValue }) => {
    try {
      const { data } = await api.patch(`/woningen/${woningId}/parameters/${parameterId}`, payload);
      return data;
    } catch (err) {
      return rejectWithValue(err.response?.data?.error?.message || 'Bijwerken mislukt');
    }
  }
);

export const deleteParameter = createAsyncThunk(
  'parameters/delete',
  async ({ woningId, parameterId }, { rejectWithValue }) => {
    try {
      await api.delete(`/woningen/${woningId}/parameters/${parameterId}`);
      return parameterId;
    } catch (err) {
      return rejectWithValue(err.response?.data?.error?.message || 'Verwijderen mislukt');
    }
  }
);

const parametersSlice = createSlice({
  name: 'parameters',
  initialState: {
    byWoning: {}, // woningId -> Parameter[]
    status: 'idle',
    error: null,
  },
  reducers: {
    liveReadingReceived(state, action) {
      const { parameterId, value, unit, timestamp } = action.payload;
      for (const woningId of Object.keys(state.byWoning)) {
        const list = state.byWoning[woningId];
        const param = list.find((p) => p._id === parameterId);
        if (param) {
          param.latest = { value, unit, timestamp };
          break;
        }
      }
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchParameters.pending, (state) => {
        state.status = 'loading';
      })
      .addCase(fetchParameters.fulfilled, (state, action) => {
        state.status = 'succeeded';
        state.byWoning[action.payload.woningId] = action.payload.parameters;
      })
      .addCase(fetchParameters.rejected, (state, action) => {
        state.status = 'error';
        state.error = action.payload;
      })
      .addCase(createParameter.fulfilled, (state, action) => {
        const woningId = action.payload.woning;
        if (!state.byWoning[woningId]) state.byWoning[woningId] = [];
        state.byWoning[woningId].push(action.payload);
      })
      .addCase(updateParameter.fulfilled, (state, action) => {
        const list = state.byWoning[action.payload.woning] || [];
        const idx = list.findIndex((p) => p._id === action.payload._id);
        if (idx !== -1) list[idx] = { ...list[idx], ...action.payload };
      })
      .addCase(deleteParameter.fulfilled, (state, action) => {
        for (const woningId of Object.keys(state.byWoning)) {
          state.byWoning[woningId] = state.byWoning[woningId].filter(
            (p) => p._id !== action.payload
          );
        }
      });
  },
});

export const { liveReadingReceived } = parametersSlice.actions;
export const selectParametersForWoning = (woningId) => (state) =>
  state.parameters.byWoning[woningId] || [];
export default parametersSlice.reducer;
