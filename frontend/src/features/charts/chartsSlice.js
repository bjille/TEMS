import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { api } from '../../services/api';

export const fetchCharts = createAsyncThunk(
  'charts/fetchAll',
  async (woningId, { rejectWithValue }) => {
    try {
      const { data } = await api.get(`/woningen/${woningId}/charts`);
      return { woningId, charts: data };
    } catch (err) {
      return rejectWithValue(err.response?.data?.error?.message || 'Kon grafieken niet laden');
    }
  }
);

export const createChart = createAsyncThunk(
  'charts/create',
  async ({ woningId, ...payload }, { rejectWithValue }) => {
    try {
      const { data } = await api.post(`/woningen/${woningId}/charts`, payload);
      return { woningId, chart: data };
    } catch (err) {
      return rejectWithValue(err.response?.data?.error?.message || 'Aanmaken mislukt');
    }
  }
);

export const updateChart = createAsyncThunk(
  'charts/update',
  async ({ woningId, chartId, ...payload }, { rejectWithValue }) => {
    try {
      const { data } = await api.patch(`/woningen/${woningId}/charts/${chartId}`, payload);
      return { woningId, chart: data };
    } catch (err) {
      return rejectWithValue(err.response?.data?.error?.message || 'Bijwerken mislukt');
    }
  }
);

export const deleteChart = createAsyncThunk(
  'charts/delete',
  async ({ woningId, chartId }, { rejectWithValue }) => {
    try {
      await api.delete(`/woningen/${woningId}/charts/${chartId}`);
      return { woningId, chartId };
    } catch (err) {
      return rejectWithValue(err.response?.data?.error?.message || 'Verwijderen mislukt');
    }
  }
);

const chartsSlice = createSlice({
  name: 'charts',
  initialState: {
    byWoning: {}, // woningId -> DashboardChart[]
  },
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchCharts.fulfilled, (state, action) => {
        state.byWoning[action.payload.woningId] = action.payload.charts;
      })
      .addCase(createChart.fulfilled, (state, action) => {
        const { woningId, chart } = action.payload;
        state.byWoning[woningId] = [...(state.byWoning[woningId] || []), chart];
      })
      .addCase(updateChart.fulfilled, (state, action) => {
        const { woningId, chart } = action.payload;
        const list = state.byWoning[woningId];
        if (!list) return;
        const i = list.findIndex((c) => c._id === chart._id);
        if (i !== -1) list[i] = chart;
      })
      .addCase(deleteChart.fulfilled, (state, action) => {
        const { woningId, chartId } = action.payload;
        const list = state.byWoning[woningId];
        if (!list) return;
        state.byWoning[woningId] = list.filter((c) => c._id !== chartId);
      });
  },
});

const EMPTY_CHARTS = [];
export const selectChartsForWoning = (woningId) => (state) =>
  state.charts.byWoning[woningId] || EMPTY_CHARTS;
export default chartsSlice.reducer;
