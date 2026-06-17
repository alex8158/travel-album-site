# Design Document: Highlight Tier Selection

## Overview

The Highlight Tier (精华) feature adds a second curation pass after the existing highlight evaluation (精选) pipeline. It selects the absolute best photos per category using category-specific VLM prompts, persists the selection as `is_highlight_tier = 1` in the existing `highlight_results` table, auto-generates a slideshow video from the tier photos, and surfaces the results in both My Gallery and the Public Gallery.

## Architecture

```
┌───────────────────────────────────────────────────────────┐
│  runHighlightEvaluation (existing orchestrator)           │
│  ┌─────────────────────────┐                             │
│  │ Phase 1-3: 精选 pipeline │                            │
│  └──────────┬──────────────┘                             │
│             │ completes                                   │
│             ▼                                             │
│  ┌─────────────────────────────────────────────┐         │
│  │ highlightTierSelector.runTierSelection()    │         │
│  │  ├── Query candidates (is_highlight=1,      │         │
│  │  │    status='active') grouped by category  │         │
│  │  ├── For each category:                     │         │
│  │  │    ├── Build category-specific prompt    │         │
│  │  │    ├── Batch (≤15 → single call;         │         │
│  │  │    │          >15 → sub-batches + final) │         │
│  │  │    └── Parse VLM JSON response           │         │
│  │  ├── Persist is_highlight_tier = 1          │         │
│  │  └── Trigger slideshow generation           │         │
│  └─────────────────────────────────────────────┘         │
└───────────────────────────────────────────────────────────┘
```

## Components

### 1. `highlightTierSelector.ts` (New Module)

**Location:** `server/src/services/highlightTierSelector.ts`

This is the core orchestrator for the tier selection pass. It exports:

- `runTierSelection(tripId: string): Promise<TierSelectionResult>` — main entry point
- `buildCategoryPrompt(category: CategoryType, photoCount: number): string` — prompt factory
- `createTierBatches(photos: TierCandidate[], batchSize?: number): TierCandidate[][]` — batch splitter
- `parseTierResponse(responseText: string, batchPhotos: TierCandidate[]): TierPick[]` — JSON parser

### 2. Database Migration

Add column to `highlight_results`:

```sql
ALTER TABLE highlight_results ADD COLUMN is_highlight_tier INTEGER DEFAULT 0;
```

Note: The `category` column on `media_items` already exists in the current schema.

### 3. Integration with Existing Pipeline

The `runHighlightEvaluation` function in `highlightService.ts` will be extended to call `runTierSelection(tripId)` after persisting highlight results. The tier selection runs as the final stage — if it fails, the highlight evaluation result is still valid and returned to the caller.

### 4. Frontend Changes

- `MyGalleryPage.tsx`: Add `'tier'` to the `FilterMode` union type. The "精华" tab filters photos by `is_highlight_tier = 1` and shows the tier slideshow video.
- `GalleryPage.tsx`: Display the tier slideshow video in the public gallery alongside the existing 精选 photo grid.

## Components and Interfaces

### Core Types

```typescript
/** Category types used for tier selection quotas and prompts */
export type TierCategory = 'animal' | 'landscape' | 'people';

/** Quota configuration per category */
export interface CategoryQuota {
  min: number;
  max: number;
}

/** Category quota map */
export const CATEGORY_QUOTAS: Record<TierCategory, CategoryQuota> = {
  animal: { min: 6, max: 9 },
  landscape: { min: 3, max: 9 },
  people: { min: 3, max: 9 },
};

/** Minimum/maximum batch size for VLM calls */
export const TIER_BATCH_MIN = 10;
export const TIER_BATCH_MAX = 15;

/** A candidate photo for tier selection */
export interface TierCandidate {
  id: string;
  filePath: string;
  category: string;
  /** 0-based index within the batch (assigned at batch creation time) */
  batchIndex?: number;
}

/** A photo selected by VLM for the tier */
export interface TierPick {
  photoId: string;
  reason: string;
}

/** Result of the full tier selection pass */
export interface TierSelectionResult {
  tripId: string;
  totalCandidates: number;
  tierCount: number;
  categoryCounts: Record<string, number>;
  slideshowGenerated: boolean;
}
```

### VLM Response Format

The VLM returns a structured JSON response matching the pattern used by the existing highlight evaluation:

```typescript
/** Expected VLM response structure for tier selection */
interface TierVLMResponse {
  selected: Array<{
    /** 0-based index of the photo in the batch */
    index: number;
    /** Reason for selection (max 100 chars) */
    reason: string;
  }>;
}
```

Example VLM response:
```json
{
  "selected": [
    {"index": 0, "reason": "Unique elephant behavior, sharp focus, excellent exposure"},
    {"index": 3, "reason": "Rare bird species in flight, perfect timing"},
    {"index": 7, "reason": "Underwater coral reef, vivid colors, sharp detail"}
  ]
}
```

### API Endpoints

```typescript
// GET /api/trips/:id/tier-photos — Return tier photos for a trip
// Response: { photos: TierPhotoItem[], slideshowUrl: string | null }

// GET /api/my/trips/:id/tier-photos — Authenticated version for My Gallery
// Response: { photos: TierPhotoItem[], slideshowUrl: string | null }
```

## Data Models

### highlight_results Table (Extended)

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID |
| trip_id | TEXT FK | References trips.id |
| photo_id | TEXT FK | References media_items.id |
| is_highlight | INTEGER | 1 if photo is 精选 |
| is_highlight_tier | INTEGER DEFAULT 0 | 1 if photo is 精华 (new) |
| reason | TEXT | Evaluation reason |
| batch_index | INTEGER | Batch number |
| evaluated_at | TEXT | ISO timestamp |

### Invariant

`is_highlight_tier = 1` ⟹ `is_highlight = 1` (enforced at application level during persistence)

## Detailed Design

### Candidate Query

```sql
SELECT mi.id, mi.file_path, mi.category
FROM highlight_results hr
INNER JOIN media_items mi ON mi.id = hr.photo_id
WHERE hr.trip_id = ?
  AND hr.is_highlight = 1
  AND mi.status = 'active'
  AND mi.category IN ('animal', 'landscape', 'people')
ORDER BY mi.category, mi.id;
```

Photos in the `'other'` category are excluded from tier selection since the tier is focused on the three primary visual categories.

### Batch Strategy

```typescript
function createTierBatches(photos: TierCandidate[]): TierCandidate[][] {
  const n = photos.length;
  
  // ≤15 photos: single batch
  if (n <= TIER_BATCH_MAX) {
    return [photos];
  }
  
  // >15 photos: split into sub-batches of 10-12
  // Target sub-batch size: ceil(n / ceil(n / 12))
  const numBatches = Math.ceil(n / 12);
  const batchSize = Math.ceil(n / numBatches);
  
  const batches: TierCandidate[][] = [];
  for (let i = 0; i < n; i += batchSize) {
    batches.push(photos.slice(i, Math.min(i + batchSize, n)));
  }
  return batches;
}
```

### Multi-Round Selection (>15 Candidates)

When a category has more than 15 candidates:

1. **Round 1**: Split into sub-batches of ~10-12. For each sub-batch, ask VLM to pick the top candidates (proportional to quota / number of batches, rounded up).
2. **Final Round**: Combine all Round 1 winners into a single batch (should be ≤15). Run one final VLM call to select the category quota from the combined winners.

### Category-Specific Prompts

Each prompt instructs the VLM on selection criteria specific to the category. All prompts share:
- The underwater-photo handling instruction
- The structured JSON response format
- The photo index reference system

```typescript
function buildCategoryPrompt(category: TierCategory, photoCount: number): string {
  const quota = CATEGORY_QUOTAS[category];
  const baseInstruction = getBaseInstruction(category, quota);
  const underwaterClause = `Note: Some photos may have a blue/green tint from underwater photography. Evaluate these fairly based on subject clarity, composition, and color vibrancy within the underwater context.`;
  
  return `You are a professional travel photography curator performing a final selection of the absolute best photos.

${baseInstruction}

${underwaterClause}

You are viewing ${photoCount} photos indexed 0 to ${photoCount - 1}.

Return ONLY a JSON object:
{
  "selected": [
    {"index": 0, "reason": "Brief explanation (max 100 chars)"}
  ]
}

Rules:
- "index" is the 0-based position of the photo
- "reason" must be concise (max 100 characters)
- Select between ${quota.min} and ${quota.max} photos (or all if fewer than ${quota.min} are available)`;
}
```

**Animal prompt instruction:**
> Select 6 to 9 photos where each shows a completely different animal subject. Each photo must be sharp with good focus on the animal. None should be overexposed. Prioritize diversity of species/subjects over quantity.

**People prompt instruction:**
> Select 3 to 9 photos where each shows a completely different scene or setting. Prioritize diversity in location, activity, and composition. Avoid multiple photos from the same moment or angle.

**Landscape prompt instruction:**
> Select 3 to 9 of the most visually distinct and compelling landscape photos. Prioritize variety in scenery, lighting conditions, and color palettes. Each selected photo should offer a unique visual perspective.

### Response Parsing

```typescript
function parseTierResponse(
  responseText: string,
  batchPhotos: TierCandidate[],
): TierPick[] {
  // 1. Extract JSON from response text (reuse extractJSON from highlightService)
  const raw = extractJSON<{ selected?: unknown[] }>(responseText);
  
  // 2. Validate structure
  if (!raw || !Array.isArray(raw.selected)) {
    throw new Error('Invalid tier VLM response: missing "selected" array');
  }
  
  // 3. Map indices to photo IDs, filtering out-of-range indices
  const picks: TierPick[] = [];
  for (const entry of raw.selected) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { index, reason } = entry as { index?: number; reason?: string };
    if (typeof index !== 'number' || !Number.isInteger(index)) continue;
    if (index < 0 || index >= batchPhotos.length) continue;
    
    picks.push({
      photoId: batchPhotos[index].id,
      reason: truncateReason(typeof reason === 'string' ? reason : ''),
    });
  }
  
  return picks;
}
```

### Persistence

After all categories are processed, the tier selector updates the database in a single transaction:

```typescript
function persistTierResults(tripId: string, picks: TierPick[]): void {
  const db = getDb();
  db.transaction(() => {
    // Reset all tier flags for this trip
    db.prepare(
      'UPDATE highlight_results SET is_highlight_tier = 0 WHERE trip_id = ?'
    ).run(tripId);
    
    // Set tier flag for selected photos
    const stmt = db.prepare(
      'UPDATE highlight_results SET is_highlight_tier = 1 WHERE trip_id = ? AND photo_id = ?'
    );
    for (const pick of picks) {
      stmt.run(tripId, pick.photoId);
    }
  })();
}
```

### Slideshow Generation

After persistence, if at least one photo was selected:

```typescript
if (allPicks.length > 0) {
  const tierPhotoPaths = allPicks.map(p => resolveFilePath(p.photoId));
  await generateSlideshow({
    photoPaths: tierPhotoPaths,
    outputDir: getSlideshowOutputDir(tripId),
    photoDuration: 3,
  });
}
```

The slideshow is stored as a video associated with the trip (reusing the existing slideshow storage pattern).

### Trash Cascade

When a photo is trashed (status set to 'trashed'), the system must also clear its tier flag:

```typescript
// In the trash operation handler:
db.prepare(
  'UPDATE highlight_results SET is_highlight_tier = 0 WHERE photo_id = ?'
).run(photoId);
```

## Error Handling

| Scenario | Behavior |
|----------|----------|
| VLM call fails | Skip batch, log error, continue with other batches |
| VLM returns unparseable JSON | Retry once, then skip batch |
| Category has 0 candidates | Skip category silently |
| Category has < min quota | Select all available |
| All VLM calls fail | Return result with tierCount=0, skip slideshow |
| Slideshow generation fails | Log error, return result with slideshowGenerated=false |

## Testing Strategy

- **Property-based tests**: Validate batch splitting, candidate filtering, quota bounds, subset invariant, and response parsing using generated inputs (100+ iterations per property).
- **Unit tests**: Verify category-specific prompt content, response parsing with specific JSON structures, persistence logic, and trash cascade behavior.
- **Integration tests**: End-to-end flow with mocked VLM — trigger highlight evaluation, verify tier selection runs, and check database state.

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Candidate Filtering Invariant

For any trip and any set of photos in the database, the tier selector SHALL only pass photos to VLM evaluation where `highlight_results.is_highlight = 1` AND `media_items.status = 'active'`. No photo failing either condition shall ever appear in a VLM batch.

**Validates: Requirements 1.2, 9.1**

### Property 2: Subset Invariant (Database Level)

For any row in the `highlight_results` table, if `is_highlight_tier = 1` then `is_highlight = 1` must also hold. There shall never exist a row where `is_highlight_tier = 1` AND `is_highlight = 0`.

**Validates: Requirements 2.4**

### Property 3: Category Quota Bounds

For any category with N highlight-eligible candidates where N ≥ the category's minimum quota, the number of photos selected by the tier selector SHALL be between `CATEGORY_QUOTAS[category].min` and `CATEGORY_QUOTAS[category].max` (inclusive). When N < minimum quota, all N candidates SHALL be selected.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4**

### Property 4: Batch Size Bounds

For any VLM call made by the tier selector, the number of photos in the batch SHALL be between `TIER_BATCH_MIN` (10) and `TIER_BATCH_MAX` (15) inclusive, except when a category has fewer than `TIER_BATCH_MIN` total candidates (in which case all candidates form a single batch).

**Validates: Requirements 4.1, 4.2**

### Property 5: Underwater Prompt Inclusion

For any category prompt generated by `buildCategoryPrompt`, the resulting prompt string SHALL contain the underwater-photo handling instruction text.

**Validates: Requirements 5.4**

### Property 6: Tier Persistence Round-Trip

For any photo selected by the VLM and passed to `persistTierResults`, querying `highlight_results` for that trip and photo SHALL return `is_highlight_tier = 1`.

**Validates: Requirements 2.3**

### Property 7: Trash Cascades Tier Flag

For any photo that has `is_highlight_tier = 1`, when that photo's status is set to 'trashed', the system SHALL set `is_highlight_tier = 0` for that photo's highlight result row.

**Validates: Requirements 9.2**

### Property 8: Trashed Exclusion from Tier Queries

For any query returning tier photos (both API endpoints and display filtering), no photo with `media_items.status = 'trashed'` SHALL appear in the result set.

**Validates: Requirements 9.3**

### Property 9: Tier Filter Display Correctness

For any trip displayed in My Gallery with the "精华" filter active, every photo shown SHALL have `is_highlight_tier = 1`, and every photo with `is_highlight_tier = 1` and `status = 'active'` SHALL be shown.

**Validates: Requirements 7.2**

### Property 10: Public Gallery Visibility Guard

For any trip, the public gallery SHALL only display photos and videos from trips where `visibility = 'public'`. No content from non-public trips shall appear in public gallery queries.

**Validates: Requirements 8.3**
