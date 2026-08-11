import { api } from '../../services/api';

export async function sendControlAction(woningId, parameterId, action, payload) {
  const { data } = await api.post(`/woningen/${woningId}/control/${parameterId}`, {
    action,
    payload,
  });
  return data;
}

export async function fetchControlHistory(woningId) {
  const { data } = await api.get(`/woningen/${woningId}/control/history`);
  return data;
}
