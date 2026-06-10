# Design Document: Global Survivor Dedup

## Overview

The Global Survivor Dedup stage is a pure-function deduplication pass inserted into the `runHighlightEvaluation` pipeline between similar-group trashing (step 10) and overexposure trashing (step 11). It detects cross-group near-duplicates among surviving active photos using pre-computed DINOv2 embeddings, clusters eligible pairs via Union-Find, and keeps only the best photo per cluster. It makes zero VLM calls — resolution is purely quality-score-based with temporal proximity as gray-zone evidence.

## Architecture

### Pipeline Position

```
Step 10: Similar-group trashing (VLM-based)
    ↓
Step 10.5: Global Survivor Dedup (embedding-based, new)
    ↓
Step 11: Overexposure trashing
```

### Design Principles

1. **Zero VLM calls** — uses only stored DINOv2 embeddings and quality scores
2. **Reuse existing code** — leverages `computeTopKNeighbors`, `cosineSimilarity`, `selectBestByQuality`, `computeCompositeScore`, and `UnionFind` from `globalSimilarity.ts` and `unionFind.ts`
3. **Fail-safe** — errors are caught and logged; the pipeline continues with zero photos trashed
4. **Soft delete** — sets `status = 'trashed'` with a specific reason; file paths are preserved

---

## Components and Interfaces

### New File: `server/src/services/smartCuration/survivorDedup.ts`

The single new module containing:
- `runSurvivorDedup()` — the entry point called from `highlightService.ts`
- `buildEligiblePairs()` — classifies neighbor pairs into confirmed or gray-zone-eligible
- `clusterAndResolve()` — clusters eligible pairs and selects keepers

### Modified File: `server/src/services/highlightService.ts`

- Add import of `runSurvivorDedup`
- Insert call between step 10 (similar-group trashing) and step 11 (overexposure trashing)
- Add `globalSimilarityAfterVlmDeletedCount` field to the `HighlightEvaluation` return type

---

## Interfaces

```typescript
// --- Input/Output types for survivorDedup.ts ---

/** A photo surviving after VLM similar-group trashing */
export interface SurvivorPhoto {
  mediaId: string;
  embedding: number[] | null;  // DINOv2 384-dim, null if missing
  createdAt: string;           // ISO 8601 timestamp
  sharpnessScore: number;
  aestheticScore: number;
  exposureScore: number;
  overexposureQualityPenalty: number;
}

/** Result of the survivor dedup stage */
export interface SurvivorDedupResult {
  trashedMediaIds: string[];
  globalSimilarityAfterVlmDeletedCount: number;
}

/** A pair eligible for elimination (confirmed or gray-zone + temporally proximate) */
interface EligiblePair {
  i: string;  // mediaId
  j: string;  // mediaId
  similarity: number;
  type: 'confirmed' | 'gray_zone_temporal';
}
```

### Updated Interface: `HighlightEvaluation`

```typescript
export interface HighlightEvaluation {
  tripId: string;
  totalPhotos: number;
  highlightCount: number;
  similarGroupCount: number;
  batchesProcessed: number;
  batchesFailed: number;
  usedProvider?: string;
  globalSimilarityAfterVlmDeletedCount?: number;  // NEW
}
```

---

## Data Models

### Database Columns Used (Existing)

| Column | Table | Usage |
|--------|-------|-------|
| `id` | `media_items` | Photo identifier |
| `trip_id` | `media_items` | Filter photos by trip |
| `status` | `media_items` | Filter active; set to 'trashed' |
| `trashed_reason` | `media_items` | Set/append reason string |
| `dinov2_embedding` | `media_items` | JSON-serialized 384-dim vector |
| `created_at` | `media_items` | Temporal proximity check, tie-breaking |
| `sharpness_score` | `media_items` | Quality composite input |
| `aesthetic_score` | `media_items` | Quality composite input |
| `exposure_score` | `media_items` | Quality composite input |
| `overexposure_quality_penalty` | `media_items` | Quality composite input |

### New Trash Reason

- Value: `'global_similarity_after_vlm'`
- Semantics: Photo was eliminated by the post-VLM global survivor dedup stage as a cross-group near-duplicate

---

## Data Flow

```
1. Query DB for active photos with DINOv2 embeddings for the trip
   ↓
2. Filter: skip photos with null embeddings
   ↓
3. computeTopKNeighbors(embeddings, globalSimilarityTopK=10)
   → NeighborPair[] sorted by descending similarity
   ↓
4. Classify pairs:
   - similarity >= 0.88 → Confirmed (eligible immediately)
   - 0.82 <= similarity < 0.88 → Gray Zone (check temporal proximity)
   - similarity < 0.82 → Skip
   ↓
5. Apply temporal gate to gray-zone pairs:
   - |createdAt_i - createdAt_j| <= 30s → eligible
   - otherwise → skip
   ↓
6. Union-Find clustering on all eligible pairs
   → clusters (connected components)
   ↓
7. For each cluster with size >= 2:
   - Compute compositeScore for each member
   - Keeper = highest score (ties: earliest createdAt)
   - Trash all others
   ↓
8. Apply DB updates: status='trashed', trashed_reason appended
   ↓
9. Return SurvivorDedupResult with trashed IDs and count
```

---

## Algorithm Detail

### Pair Classification

```typescript
function buildEligiblePairs(
  neighbors: NeighborPair[],
  survivors: SurvivorPhoto[],
  mediaIds: string[],
): EligiblePair[] {
  const { dinov2ConfirmedThreshold, dinov2DedupThreshold } = PROCESS_THRESHOLDS;
  const eligible: EligiblePair[] = [];

  for (const pair of neighbors) {
    if (pair.similarity >= dinov2ConfirmedThreshold) {
      // Confirmed: no additional evidence needed
      eligible.push({
        i: mediaIds[pair.i],
        j: mediaIds[pair.j],
        similarity: pair.similarity,
        type: 'confirmed',
      });
    } else if (pair.similarity >= dinov2DedupThreshold) {
      // Gray zone: require temporal proximity
      const photoI = survivors.find(s => s.mediaId === mediaIds[pair.i]);
      const photoJ = survivors.find(s => s.mediaId === mediaIds[pair.j]);
      if (photoI && photoJ) {
        const timeDiffMs = Math.abs(
          new Date(photoI.createdAt).getTime() - new Date(photoJ.createdAt).getTime()
        );
        if (timeDiffMs <= 30_000) {
          eligible.push({
            i: mediaIds[pair.i],
            j: mediaIds[pair.j],
            similarity: pair.similarity,
            type: 'gray_zone_temporal',
          });
        }
      }
    }
    // Below dinov2DedupThreshold: skip entirely
  }

  return eligible;
}
```

### Cluster Resolution

```typescript
function clusterAndResolve(
  eligiblePairs: EligiblePair[],
  survivors: SurvivorPhoto[],
): string[] {
  // Build clusters via Union-Find
  const uf = new UnionFind();
  for (const pair of eligiblePairs) {
    uf.makeSet(pair.i);
    uf.makeSet(pair.j);
    uf.union(pair.i, pair.j);
  }

  // Also register isolated survivors (won't form clusters)
  const groups = uf.getGroups();
  const trashedIds: string[] = [];

  for (const [_root, members] of groups.entries()) {
    if (members.length < 2) continue;

    // Build candidates for selectBestByQuality
    const candidates: CurationCandidate[] = members.map(id => {
      const photo = survivors.find(s => s.mediaId === id)!;
      return {
        mediaId: id,
        sharpnessScore: photo.sharpnessScore,
        aestheticScore: photo.aestheticScore,
        exposureScore: photo.exposureScore,
        overexposureQualityPenalty: photo.overexposureQualityPenalty,
      };
    });

    // Select keeper (highest composite score)
    const keeperId = selectBestByQuality(candidates);

    // Tie-breaking: if multiple have same score, keep earliest createdAt
    const keeperScore = computeCompositeScore(
      candidates.find(c => c.mediaId === keeperId)!
    );
    const tiedCandidates = candidates.filter(
      c => computeCompositeScore(c) === keeperScore
    );
    let finalKeeperId = keeperId;
    if (tiedCandidates.length > 1) {
      tiedCandidates.sort((a, b) => {
        const timeA = new Date(survivors.find(s => s.mediaId === a.mediaId)!.createdAt).getTime();
        const timeB = new Date(survivors.find(s => s.mediaId === b.mediaId)!.createdAt).getTime();
        return timeA - timeB;
      });
      finalKeeperId = tiedCandidates[0].mediaId;
    }

    // Trash everyone else
    for (const member of members) {
      if (member !== finalKeeperId) {
        trashedIds.push(member);
      }
    }
  }

  return trashedIds;
}
```

### Entry Point

```typescript
export async function runSurvivorDedup(
  tripId: string,
): Promise<SurvivorDedupResult> {
  try {
    const db = getDb();

    // 1. Load active survivors with embeddings and quality scores
    const rows = db.prepare(`
      SELECT m.id, m.created_at, m.dinov2_embedding,
             m.sharpness_score, m.aesthetic_score,
             m.exposure_score, m.overexposure_quality_penalty
      FROM media_items m
      WHERE m.trip_id = ? AND m.status = 'active'
        AND m.media_type = 'image'
      ORDER BY m.created_at ASC
    `).all(tripId) as SurvivorRow[];

    // 2. Early exit: 0 or 1 survivors means nothing to dedup
    if (rows.length <= 1) {
      return { trashedMediaIds: [], globalSimilarityAfterVlmDeletedCount: 0 };
    }

    // 3. Parse embeddings, filter out nulls for neighbor computation
    const survivors: SurvivorPhoto[] = rows.map(r => ({
      mediaId: r.id,
      embedding: r.dinov2_embedding ? JSON.parse(r.dinov2_embedding) : null,
      createdAt: r.created_at,
      sharpnessScore: r.sharpness_score ?? 0,
      aestheticScore: r.aesthetic_score ?? 0,
      exposureScore: r.exposure_score ?? 0,
      overexposureQualityPenalty: r.overexposure_quality_penalty ?? 0,
    }));

    const mediaIds = survivors.map(s => s.mediaId);
    const embeddings = survivors.map(s => s.embedding);

    // 4. Compute top-K neighbors
    const neighbors = computeTopKNeighbors(
      embeddings,
      PROCESS_THRESHOLDS.globalSimilarityTopK,
    );

    if (neighbors.length === 0) {
      return { trashedMediaIds: [], globalSimilarityAfterVlmDeletedCount: 0 };
    }

    // 5. Classify pairs and apply temporal gate
    const eligiblePairs = buildEligiblePairs(neighbors, survivors, mediaIds);

    if (eligiblePairs.length === 0) {
      return { trashedMediaIds: [], globalSimilarityAfterVlmDeletedCount: 0 };
    }

    // 6. Cluster and resolve
    const trashedIds = clusterAndResolve(eligiblePairs, survivors);

    if (trashedIds.length === 0) {
      return { trashedMediaIds: [], globalSimilarityAfterVlmDeletedCount: 0 };
    }

    // 7. Apply DB updates
    const trashStmt = db.prepare(`
      UPDATE media_items
      SET status = 'trashed',
          trashed_reason = CASE
            WHEN trashed_reason IS NULL THEN 'global_similarity_after_vlm'
            ELSE trashed_reason || ',global_similarity_after_vlm'
          END
      WHERE id = ? AND status = 'active'
    `);

    let actualTrashed = 0;
    for (const id of trashedIds) {
      const info = trashStmt.run(id);
      if (info.changes > 0) actualTrashed++;
    }

    // 8. Log
    if (actualTrashed > 0) {
      console.log(
        `[highlightService] Auto-trashed ${actualTrashed} global-survivor-dedup photos for trip ${tripId}`,
      );
    }

    return {
      trashedMediaIds: trashedIds.slice(0, actualTrashed),
      globalSimilarityAfterVlmDeletedCount: actualTrashed,
    };
  } catch (err) {
    console.error(`[highlightService] Global survivor dedup failed for trip ${tripId}:`, err);
    return { trashedMediaIds: [], globalSimilarityAfterVlmDeletedCount: 0 };
  }
}
```

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| DB query fails | Caught by try/catch; returns 0 trashed, logs error |
| Embedding parse fails (invalid JSON) | Photo treated as null embedding, skipped |
| computeTopKNeighbors throws | Caught; returns 0 trashed |
| Trash UPDATE fails for one photo | Individual failure doesn't stop others; `actualTrashed` reflects reality |
| Zero survivors or one survivor | Early return with 0 trashed (no error) |

---

## Integration into `highlightService.ts`

```typescript
// After step 10 (similar-group trashing), before step 11 (overexposure trashing):

// 10.5) Global survivor dedup — cross-group near-duplicate elimination
let globalSimilarityAfterVlmDeletedCount = 0;
try {
  const { runSurvivorDedup } = await import('./smartCuration/survivorDedup');
  const dedupResult = await runSurvivorDedup(tripId);
  globalSimilarityAfterVlmDeletedCount = dedupResult.globalSimilarityAfterVlmDeletedCount;
} catch (err) {
  console.error(`[highlightService] Global survivor dedup error: ${err}`);
}
```

The `globalSimilarityAfterVlmDeletedCount` is then included in the returned `HighlightEvaluation` object.

---

## Testing Strategy

### Unit Tests
- Verify early-exit behavior (0 survivors, 1 survivor, all null embeddings)
- Verify logging output format matches existing pattern
- Verify error handling returns zero-trashed result

### Property-Based Tests
- Pair classification correctness (threshold boundaries)
- Temporal gate correctness (30-second window)
- Keeper selection (highest quality wins, tie-breaking by timestamp)
- Cluster resolution (transitive closure, single keeper per cluster)
- Trash metadata (reason string, append behavior)
- Count accuracy (reported matches actual)

### Integration Tests
- Stage executes in correct pipeline position (after step 10, before step 11)
- DB embeddings are loaded correctly
- Correct functions are called (`computeTopKNeighbors`, `cosineSimilarity`, `selectBestByQuality`)
- No VLM/embedding recomputation calls are made

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Only Active Photos Processed

*For any* set of photos with mixed statuses (active, trashed, deleted), the survivor dedup stage SHALL only consider photos with `status = 'active'` as candidates for dedup — no photo with a non-active status shall appear in the output `trashedMediaIds`.

**Validates: Requirements 1.2, 9.4**

### Property 2: Threshold-Based Pair Classification

*For any* two photos with valid DINOv2 embeddings, if their cosine similarity is >= 0.88 then the pair SHALL be classified as confirmed-eligible; if their similarity is in [0.82, 0.88) then the pair SHALL be classified as gray-zone; if below 0.82 then the pair SHALL NOT be eligible for elimination.

**Validates: Requirements 3.1, 4.1**

### Property 3: Gray-Zone Temporal Gate

*For any* gray-zone pair (similarity in [0.82, 0.88)), the pair is eligible for elimination if and only if |createdAt_i - createdAt_j| <= 30 seconds. Pairs with timestamp difference > 30 seconds SHALL both survive regardless of similarity.

**Validates: Requirements 4.2, 4.3**

### Property 4: Keeper Selection by Quality

*For any* eligible pair or cluster of photos, the photo with the highest composite quality score (`sharpness * 0.4 + aesthetic * 0.3 + exposure * 0.3 + overexposurePenalty`) SHALL be kept, and all others SHALL be trashed.

**Validates: Requirements 3.2, 4.4, 5.1, 8.2**

### Property 5: Tie-Breaking by Earliest Timestamp

*For any* two photos with identical composite quality scores that are in the same eligible cluster, the photo with the earlier `created_at` timestamp SHALL be selected as the keeper.

**Validates: Requirements 5.3**

### Property 6: Composite Score Formula Correctness

*For any* set of quality metrics (sharpness, aesthetic, exposure, overexposurePenalty), the computed composite score SHALL equal `sharpness * 0.4 + aesthetic * 0.3 + exposure * 0.3 + overexposurePenalty` exactly.

**Validates: Requirements 5.1**

### Property 7: Trash Metadata Correctness

*For any* photo trashed by the survivor dedup stage: (a) `status` SHALL be set to `'trashed'`; (b) `file_path` SHALL remain unchanged; (c) `trashed_reason` SHALL be `'global_similarity_after_vlm'` if previously null, or the previous value with `',global_similarity_after_vlm'` appended.

**Validates: Requirements 6.1, 6.2, 6.3**

### Property 8: Cluster Transitive Closure

*For any* set of eligible pairs forming a connected graph (where A~B and B~C implies A, B, C are in the same cluster), all members of the connected component SHALL be resolved together as one cluster with exactly one keeper.

**Validates: Requirements 8.1, 8.3**

### Property 9: Reported Count Accuracy

*For any* execution of the survivor dedup stage, the `globalSimilarityAfterVlmDeletedCount` in the result SHALL equal the actual number of photos whose status was changed from 'active' to 'trashed' by this stage.

**Validates: Requirements 7.1**
