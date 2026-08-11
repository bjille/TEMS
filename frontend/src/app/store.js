import { configureStore } from '@reduxjs/toolkit';
import authReducer from '../features/auth/authSlice';
import woningenReducer from '../features/woningen/woningenSlice';
import parametersReducer from '../features/parameters/parametersSlice';
import adminUsersReducer from '../features/admin/adminUsersSlice';
import automationsReducer from '../features/automations/automationsSlice';
import globalAutomationsReducer from '../features/admin/globalAutomationsSlice';

export const store = configureStore({
  reducer: {
    auth: authReducer,
    woningen: woningenReducer,
    parameters: parametersReducer,
    adminUsers: adminUsersReducer,
    automations: automationsReducer,
    globalAutomations: globalAutomationsReducer,
  },
});
