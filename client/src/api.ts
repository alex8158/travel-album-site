import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';

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
