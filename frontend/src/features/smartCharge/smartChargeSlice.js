import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { api } from '../../services/api';

export const fetchSmartChargePlans = createAsyncThunk(
  'smartCharge/fetchAll',
  async (woningId, { rejectWithValue }) => {
    try {
      const { data } = await api.get(`/woningen/${woningId}/smart-charge`);
      return { woningId, plans: data };
    } catch (err) {
      return rejectWithValue(err.response?.data?.error?.message || 'Kon slim-laadplannen niet laden');
    }
  }
);

export const createSmartChargePlan = createAsyncThunk(
  'smartCharge/create',
  async ({ woningId, ...payload }, { rejectWithValue }) => {
    try {
      const { data } = await api.post(`/woningen/${woningId}/smart-charge`, payload);
      return { woningId, plan: data };
    } catch (err) {
      return rejectWithValue(err.response?.data?.error?.message || 'Aanmaken mislukt');
    }
  }
);

export const updateSmartChargePlan = createAsyncThunk(
  'smartCharge/update',
  async ({ woningId, planId, ...payload }, { rejectWithValue }) => {
    try {
      const { data } = await api.patch(`/woningen/${woningId}/smart-charge/${planId}`, payload);
      return { woningId, plan: data };
    } catch (err) {
      return rejectWithValue(err.response?.data?.error?.message || 'Bijwerken mislukt');
    }
  }
);

export const toggleSmartChargePlan = createAsyncThunk(
  'smartCharge/toggle',
  async ({ woningId, planId, enabled }, { rejectWithValue }) => {
    try {
      const { data } = await api.patch(`/woningen/${woningId}/smart-charge/${planId}/toggle`, { enabled });
      return { woningId, plan: data };
    } catch (err) {
      return rejectWithValue(err.response?.data?.error?.message || 'Aan/uit zetten mislukt');
    }
  }
);

export const deleteSmartChargePlan = createAsyncThunk(
  'smartCharge/delete',
  async ({ woningId, planId }, { rejectWithValue }) => {
    try {
      await api.delete(`/woningen/${woningId}/smart-charge/${planId}`);
      return { woningId, planId };
    } catch (err) {
      return rejectWithValue(err.response?.data?.error?.message || 'Verwijderen mislukt');
    }
  }
);

const smartChargeSlice = createSlice({
  name: 'smartCharge',
  initialState: {
    byWoning: {}, // woningId -> SmartChargePlan[] (each with a computed `status`)
  },
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchSmartChargePlans.fulfilled, (state, action) => {
        state.byWoning[action.payload.woningId] = action.payload.plans;
      })
      .addCase(createSmartChargePlan.fulfilled, (state, action) => {
        const { woningId, plan } = action.payload;
        state.byWoning[woningId] = [...(state.byWoning[woningId] || []), plan];
      })
      .addCase(updateSmartChargePlan.fulfilled, applyPlanUpdate)
      .addCase(toggleSmartChargePlan.fulfilled, applyPlanUpdate)
      .addCase(deleteSmartChargePlan.fulfilled, (state, action) => {
        const { woningId, planId } = action.payload;
        const list = state.byWoning[woningId];
        if (!list) return;
        state.byWoning[woningId] = list.filter((p) => p._id !== planId);
      });
  },
});

// update/toggle both return the freshly populated plan, but not its `status`
// (only the list endpoint computes that) — keep whatever status the plan
// already had in the store rather than dropping it until the next refresh.
function applyPlanUpdate(state, action) {
  const { woningId, plan } = action.payload;
  const list = state.byWoning[woningId];
  if (!list) return;
  const i = list.findIndex((p) => p._id === plan._id);
  if (i !== -1) list[i] = { ...list[i], ...plan };
}

const EMPTY_PLANS = [];
export const selectSmartChargePlansForWoning = (woningId) => (state) =>
  state.smartCharge.byWoning[woningId] || EMPTY_PLANS;
export default smartChargeSlice.reducer;
