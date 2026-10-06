import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { GalleryData } from './GalleryPage';
// Inlined at build time by Vite; lets the source-level regression check below
// run without pulling in Node type definitions.
import myGalleryPageSource from './MyGalleryPage.tsx?raw';

// authFetch is the single request path for this page; mock the module so we can
// observe the exact URL the download button asks for.
vi.mock('../contexts/AuthContext', () => ({
  authFetch: vi.fn(),
  useAuth: () => ({
    token: 'test-token',
    user: { userId: 'user-1', username: 'owner', role: 'regular' as const },
    isLoggedIn: true,
  }),
}));

import MyGalleryPage from './MyGalleryPage';
import { authFetch } from '../contexts/AuthContext';

const mockedAuthFetch = vi.mocked(authFetch);

const COMPILED_VIDEO_ID = 'vid-compiled-1';
const RAW_VIDEO_ID = 'vid-merged-1';

const sampleData: GalleryData = {
  trip: {
    id: 'trip-1',
    title: '东京之旅',
    userId: 'user-1',
    visibility: 'public',
    createdAt: '2024-03-15T10:00:00.000Z',
    updatedAt: '2024-03-15T10:00:00.000Z',
  },
  images: [],
  videos: [
    {
      id: COMPILED_VIDEO_ID,
      tripId: 'trip-1',
      filePath: '/uploads/trip-1/originals/a.mp4',
      mediaType: 'video',
      mimeType: 'video/mp4',
      originalFilename: 'a.mp4',
      fileSize: 1024,
      thumbnailUrl: `/api/media/${COMPILED_VIDEO_ID}/thumbnail`,
      compiledPath: '/uploads/trip-1/compiled/a_compiled.mp4',
    },
    {
      id: RAW_VIDEO_ID,
      tripId: 'trip-1',
      filePath: '/uploads/trip-1/originals/b.mp4',
      mediaType: 'video',
      mimeType: 'video/mp4',
      originalFilename: 'b.mp4',
      fileSize: 2048,
      thumbnailUrl: `/api/media/${RAW_VIDEO_ID}/thumbnail`,
      mediaSource: 'merged',
    },
  ],
  originalVideos: [],
  compiledVideos: [],
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    blob: async () => new Blob(['x'], { type: 'video/mp4' }),
  } as unknown as Response;
}

/**
 * Route authFetch by URL. Anything the page requests on mount that this test
 * does not care about resolves to 404 so the page's best-effort loaders bail
 * out quietly instead of hanging.
 */
function installAuthFetchRouter(data: GalleryData) {
  mockedAuthFetch.mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/my/trips/trip-1/gallery') {
      return Promise.resolve(jsonResponse(data));
    }
    if (url === '/api/trips/trip-1/trash') {
      return Promise.resolve(jsonResponse([]));
    }
    if (url.startsWith('/api/media/')) {
      // Download requests — resolve so the handler completes without alerting.
      return Promise.resolve(jsonResponse({}));
    }
    return Promise.resolve(jsonResponse({ error: 'not found' }, 404));
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/my/trips/trip-1']}>
      <Routes>
        <Route path="/my/trips/:id" element={<MyGalleryPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Open the 剪辑视频 tab and return the download button for a given video. */
async function openCompiledTabAndGetDownloadButton(videoId: string) {
  await waitFor(() => {
    expect(screen.getByTestId('video-tab-compiled')).toBeInTheDocument();
  });
  fireEvent.click(screen.getByTestId('video-tab-compiled'));
  await waitFor(() => {
    expect(screen.getByTestId(`download-compiled-btn-${videoId}`)).toBeInTheDocument();
  });
  return screen.getByTestId(`download-compiled-btn-${videoId}`);
}

function mediaRequestUrls(): string[] {
  return mockedAuthFetch.mock.calls
    .map((c) => String(c[0]))
    .filter((u) => u.startsWith('/api/media/'));
}

describe('MyGalleryPage compiled video download', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // jsdom does not implement the object-URL APIs the download handler uses.
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock');
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  // T1 — compiledPath present → the attachment download endpoint that actually
  // exists on the server (GET /api/media/:mediaId/download-compiled, clips.ts).
  it('requests /download-compiled when the video has a compiledPath', async () => {
    installAuthFetchRouter({
      ...sampleData,
      compiledVideos: [sampleData.videos[0]],
    });
    renderPage();

    const btn = await openCompiledTabAndGetDownloadButton(COMPILED_VIDEO_ID);
    fireEvent.click(btn);

    await waitFor(() => {
      expect(mediaRequestUrls()).toContain(
        `/api/media/${COMPILED_VIDEO_ID}/download-compiled`,
      );
    });
  });

  // T1 (negative half) — the dead endpoint must never be requested.
  it('never requests the non-existent /api/media/:id/compiled endpoint', async () => {
    installAuthFetchRouter({
      ...sampleData,
      compiledVideos: [sampleData.videos[0]],
    });
    renderPage();

    const btn = await openCompiledTabAndGetDownloadButton(COMPILED_VIDEO_ID);
    fireEvent.click(btn);

    await waitFor(() => {
      expect(mediaRequestUrls().length).toBeGreaterThan(0);
    });
    expect(mediaRequestUrls()).not.toContain(`/api/media/${COMPILED_VIDEO_ID}/compiled`);
  });

  // T2 — no compiledPath → unchanged /raw fallback.
  it('still requests /raw when the video has no compiledPath', async () => {
    installAuthFetchRouter({
      ...sampleData,
      compiledVideos: [sampleData.videos[1]],
    });
    renderPage();

    const btn = await openCompiledTabAndGetDownloadButton(RAW_VIDEO_ID);
    fireEvent.click(btn);

    await waitFor(() => {
      expect(mediaRequestUrls()).toContain(`/api/media/${RAW_VIDEO_ID}/raw`);
    });
    expect(mediaRequestUrls()).not.toContain(
      `/api/media/${RAW_VIDEO_ID}/download-compiled`,
    );
  });

  // T3 — source-level regression lock. Scoped to this page only; the former
  // occurrence in server/src/routes/gallery.ts was removed by ⑤A-2.
  it('has no remaining /api/media/${...}/compiled literal in MyGalleryPage source', () => {
    const src = myGalleryPageSource;
    // Guard against a silently-empty read making this assertion vacuous.
    expect(src).toContain('download-compiled-btn-');
    const deadEndpoint = /\/api\/media\/\$\{[^}]*\}\/compiled(?![-\w])/g;
    expect(src.match(deadEndpoint)).toBeNull();
  });
});

// Tier slideshow files are served to owner/admin only, via the bearer token that a
// plain <video src> cannot send. The page must fetch them through authFetch and
// play the resulting object URL, both on first load and after regeneration.
describe('MyGalleryPage tier slideshow playback', () => {
  const V1 = '/api/trips/trip-1/tier-slideshow/animal/slideshow_1.mp4';
  const V2 = '/api/trips/trip-1/tier-slideshow/animal/slideshow_2.mp4';

  const tierData: GalleryData = {
    ...sampleData,
    images: [
      {
        item: {
          id: 'img-1',
          tripId: 'trip-1',
          filePath: '/uploads/trip-1/originals/img-1.jpg',
          mediaType: 'image',
          mimeType: 'image/jpeg',
          originalFilename: 'a.jpg',
          fileSize: 100,
        },
        isDefault: true,
        thumbnailUrl: '/api/media/img-1/thumbnail',
        originalUrl: '/api/media/img-1/original',
      },
    ],
  };
  const tierPhoto = {
    id: 'img-1',
    filePath: '/x.jpg',
    thumbnailUrl: '/api/media/img-1/thumbnail',
    originalUrl: '/api/media/img-1/original',
    category: 'animal',
    reason: 'top',
  };

  function videoResponse(url: string): Response {
    return {
      ok: true,
      status: 200,
      blob: async () => ({ fetchedFrom: url }) as unknown as Blob,
    } as unknown as Response;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.URL.createObjectURL = vi.fn(
      (b: { fetchedFrom: string }) => `blob:${b.fetchedFrom}`,
    ) as unknown as typeof URL.createObjectURL;
    globalThis.URL.revokeObjectURL = vi.fn();
    mockedAuthFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/my/trips/trip-1/gallery') return Promise.resolve(jsonResponse(tierData));
      if (url === '/api/trips/trip-1/trash') return Promise.resolve(jsonResponse([]));
      if (url === '/api/my/trips/trip-1/tier-photos') {
        return Promise.resolve(jsonResponse({ photos: [tierPhoto], slideshowUrls: { animal: V1 } }));
      }
      if (url === '/api/my/trips/trip-1/tier-slideshow/regenerate') {
        return Promise.resolve(jsonResponse({ slideshowUrls: { animal: V2 } }));
      }
      if (url === V1 || url === V2) return Promise.resolve(videoResponse(url));
      return Promise.resolve(jsonResponse({ error: 'not found' }, 404));
    });
  });

  async function openTierTab() {
    await waitFor(() => {
      expect(screen.getByTestId('highlight-filter-tier')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('highlight-filter-tier'));
    await waitFor(() => {
      expect(screen.getByTestId('tier-slideshow')).toBeInTheDocument();
    });
  }

  function videoFetchUrls(): string[] {
    return mockedAuthFetch.mock.calls.map((c) => String(c[0])).filter((u) => u === V1 || u === V2);
  }

  it('fetches the tier video through authFetch and plays the object URL on first load', async () => {
    renderPage();
    await openTierTab();

    const video = await screen.findByLabelText('精华视频 - animal');
    expect(video.tagName).toBe('VIDEO');
    expect(video.getAttribute('src')).toBe(`blob:${V1}`);
    expect(video.hasAttribute('controls')).toBe(true);
    expect(videoFetchUrls()).toEqual([V1]);
  });

  it('plays the regenerated video and revokes the previous object URL', async () => {
    renderPage();
    await openTierTab();
    await waitFor(() => {
      expect(screen.getByLabelText('精华视频 - animal').getAttribute('src')).toBe(`blob:${V1}`);
    });

    fireEvent.click(screen.getByTestId('tier-regenerate-btn'));

    await waitFor(() => {
      expect(screen.getByLabelText('精华视频 - animal').getAttribute('src')).toBe(`blob:${V2}`);
    });
    expect(videoFetchUrls()).toEqual([V1, V2]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(`blob:${V1}`);
  });

  it('shows an error instead of a broken video when the file request fails', async () => {
    const base = mockedAuthFetch.getMockImplementation()!;
    mockedAuthFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === V1
        ? Promise.resolve(jsonResponse({ error: 'not found' }, 404))
        : base(input, init),
    );
    renderPage();
    await openTierTab();

    const slideshow = screen.getByTestId('tier-slideshow');
    await waitFor(() => {
      expect(slideshow.textContent).toContain('视频加载失败');
    });
    expect(slideshow.querySelector('video')).toBeNull();
  });
});
