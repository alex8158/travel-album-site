import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { authFetch } from './contexts/AuthContext';

export function apiPost<T = any>(url: string, data?: any, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
  return axios.post(url, data, config);
}

export function isApiError(error: unknown): boolean {
  return axios.isAxiosError(error);
}

export function getApiErrorMessage(error: unknown): string | undefined {
  if (axios.isAxiosError(error)) {
    return error.response?.data?.error?.message;
  }
  return undefined;
}

export async function updateCategory(mediaId: string, category: string): Promise<Response> {
  return authFetch(`/api/media/${mediaId}/category`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category }),
  });
}
