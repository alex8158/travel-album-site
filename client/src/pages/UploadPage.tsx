import { useState } from 'react';
import { Link } from 'react-router-dom';
import TripCreateForm from '../components/TripCreateForm';
import FileUploader from '../components/FileUploader';
import ProcessTrigger from '../components/ProcessTrigger';

type Step = 'create' | 'upload' | 'process' | 'done';

export default function UploadPage() {
  const [step, setStep] = useState<Step>('create');
  const [tripId, setTripId] = useState('');
  const [tripTitle, setTripTitle] = useState('');

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
          <div style={{ display: 'flex', gap: '12px', marginTop: '16px' }}>
            <Link to={`/trips/${tripId}`}>查看相册</Link>
            <Link to="/">返回首页</Link>
          </div>
        </div>
      )}
    </div>
  );
}
