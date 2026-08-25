import { configureStore } from '@reduxjs/toolkit';
import authReducer, { tokensCleared } from '../features/auth/authSlice';
import woningenReducer from '../features/woningen/woningenSlice';
import parametersReducer from '../features/parameters/parametersSlice';
import adminUsersReducer from '../features/admin/adminUsersSlice';
import automationsReducer from '../features/automations/automationsSlice';
import globalAutomationsReducer from '../features/admin/globalAutomationsSlice';
import globalParametersReducer from '../features/admin/globalParametersSlice';
import parameterCategoriesReducer from '../features/parameters/parameterCategoriesSlice';
import chartsReducer from '../features/charts/chartsSlice';
import { onTokensRefresh } from '../services/api';

export const store = configureStore({
  reducer: {
    auth: authReducer,
    woningen: woningenReducer,
    parameters: parametersReducer,
    adminUsers: adminUsersReducer,
    automations: automationsReducer,
    globalAutomations: globalAutomationsReducer,
    globalParameters: globalParametersReducer,
    parameterCategories: parameterCategoriesReducer,
    charts: chartsReducer,
  },
});

// A session that has been idle long enough for the refresh token to expire
// as well surfaces as a 401 on whichever request happens to fire next (not
// necessarily the auth/me check) leaving stale/empty data on screen. Clearing
// auth state here, for any request, makes ProtectedRoute redirect home.
onTokensRefresh((tokens) => {
  if (!tokens) {
    store.dispatch(tokensCleared());
  }
});
