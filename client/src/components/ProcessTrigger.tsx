import { useState } from 'react';
import axios from 'axios';

export interface ProcessResult {
  tripId: string;
  totalImages: number;
  duplicateGroups: { groupId: string; imageCount: number }[];
  totalGroups: number;
  coverImageId?: string;
}

export interface ProcessTriggerProps {
  tripId: string;
  onProcessed?: (result: ProcessResult) => void;
}

export default function ProcessTrigger({ tripId, onProcessed }: ProcessTriggerProps) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ProcessResult | null>(null);
  const [error, setError] = useState('');

  async function handleProcess() {
    setLoading(true);
    setError('');
    setResult(null);

    try {
      const res = await axios.post<ProcessResult>(`/api/trips/${tripId}/process`);
      setResult(res.data);
      onProcessed?.(res.data);
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.data?.error?.message) {
        setError(err.response.data.error.message);
      } else {
        setError('处理失败，请重试');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div aria-label="素材处理">
      <button onClick={handleProcess} disabled={loading}>
        {loading ? '处理中...' : '开始处理'}
      </button>

      {error && <p role="alert" style={{ color: 'red' }}>{error}</p>}

      {result && (
        <div aria-label="去重摘要">
          <p>共检测到 {result.totalGroups} 个重复组</p>
          {result.duplicateGroups.length > 0 && (
            <ul>
              {result.duplicateGroups.map((g) => (
                <li key={g.groupId}>组 {g.groupId}：{g.imageCount} 张图片</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
