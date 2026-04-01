import { useState } from 'react';
import { Link } from 'react-router-dom';
import TripCreateForm from '../components/TripCreateForm';
import FileUploader from '../components/FileUploader';
import ProcessTrigger from '../components/ProcessTrigger';

type Step = 'create' | 'upload' | 'process' | 'done';
type Visibility = 'public' | 'unlisted';

export default function UploadPage() {
  const [step, setStep] = useState<Step>('create');
  const [tripId, setTripId] = useState('');
  const [tripTitle, setTripTitle] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('public');
  const [updating, setUpdating] = useState(false);

  const handleVisibilityChange = async (value: Visibility) => {
    setVisibility(value);
    if (!tripId) return;
    setUpdating(true);
    try {
      await fetch(`/api/trips/${tripId}/visibility`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visibility: value }),
      });
    } catch {
      // keep selected value even on error — default public is safe
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div style={{ maxWidth: '700px', margin: '0 auto', padding: '16px' }}>
      <h1>创建旅行</h1>

      {step === 'create' && (
        <TripCreateForm
          onCreated={(trip) => {
            setTripId(trip.id);
            setTripTitle(trip.title);
            setStep('upload');
          }}
        />
      )}

      {step === 'upload' && tripId && (
        <div>
          <h2>上传素材 - {tripTitle}</h2>
          <FileUploader tripId={tripId} />
          <div style={{ marginTop: '16px' }}>
            <button onClick={() => setStep('process')}>上传完成，开始处理</button>
          </div>
        </div>
      )}

      {step === 'process' && tripId && (
        <div>
          <h2>处理素材 - {tripTitle}</h2>
          <ProcessTrigger
            tripId={tripId}
            onProcessed={() => setStep('done')}
          />
        </div>
      )}

      {step === 'done' && (
        <div aria-label="完成">
          <h2>处理完成！</h2>
          <p>旅行「{tripTitle}」已创建并处理完成。</p>

          <fieldset style={{ border: '1px solid #ccc', borderRadius: '8px', padding: '12px', marginTop: '16px' }}>
            <legend>相册可见性</legend>
            <label style={{ display: 'block', marginBottom: '8px', cursor: 'pointer' }}>
              <input
                type="radio"
                name="visibility"
                value="public"
                checked={visibility === 'public'}
                onChange={() => handleVisibilityChange('public')}
                disabled={updating}
              />{' '}
              公开
            </label>
            <label style={{ display: 'block', cursor: 'pointer' }}>
              <input
                type="radio"
                name="visibility"
                value="unlisted"
                checked={visibility === 'unlisted'}
                onChange={() => handleVisibilityChange('unlisted')}
                disabled={updating}
              />{' '}
              不公开
            </label>
          </fieldset>

          <div style={{ display: 'flex', gap: '12px', marginTop: '16px' }}>
            <Link to={`/trips/${tripId}`}>查看相册</Link>
            <Link to="/">返回首页</Link>
          </div>
        </div>
      )}
    </div>
  );
}
