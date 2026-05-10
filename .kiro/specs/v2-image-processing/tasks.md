# Tasks

## 1. Color Cast Detector

- [x] 1.1 Create `server/src/services/colorCastDetector.ts` with types (ColorCastType, SeverityLevel, ColorCastResult, BatchColorCastResult)
- [x] 1.2 Implement `detectColorCast(channelMeans)` pure function: compute deviations, classify type and severity, produce colorScore
- [x] 1.3 Implement `detectColorCastFromFile(imagePath)` using sharp.stats() to get channel means then call detectColorCast
- [x] 1.4 Implement persistence logic: write color_score and structured JSON reason to media_analysis table (upsert)
- [x] 1.5 Implement `detectColorCastBatch(tripId)` for batch processing with error resilience and summary aggregation
- [x] 1.6 Write property-based tests for detectColorCast (Properties 1, 2, 3) using fast-check
- [x] 1.7 Write unit tests for detectColorCastFromFile and batch processing

## 2. AI Provider Abstraction

- [x] 2.1 Create `server/src/services/ai/types.ts` with AIResponse, AICapability, AIProviderMetadata, AIProvider interface
- [x] 2.2 Create `server/src/services/ai/registry.ts` with AIProviderRegistry class (register, get, getDefault, listProviders)
- [x] 2.3 Implement auto-logging in registry: invokeText and invokeImageAnalysis methods that wrap provider calls with ai_invocations records
- [x] 2.4 Create `server/src/services/ai/bedrockProvider.ts` implementing AIProvider by wrapping existing createBedrockClient
- [x] 2.5 Create `server/src/services/ai/openaiProvider.ts` implementing AIProvider by wrapping existing createOpenAIClient
- [x] 2.6 Create `server/src/services/ai/index.ts` barrel export and getAIProviderRegistry singleton factory
- [x] 2.7 Write property-based tests for registry lookup (Property 6) using fast-check
- [x] 2.8 Write unit tests for provider implementations with mocked clients

## 3. AI Enhancement Service

- [x] 3.1 Create `server/src/services/aiEnhancementService.ts` with EnhancementParams, EnhancementResult, BatchEnhancementResult types
- [x] 3.2 Implement `validateAndClampParams(params)` pure function for parameter safety bounds
- [x] 3.3 Implement `parseAIResponse(responseText)` to extract EnhancementParams from AI response JSON
- [x] 3.4 Implement `analyzeForEnhancement(mediaId)` — send image to AI provider, parse response, fallback to computeOptimizeParams
- [x] 3.5 Implement `applyEnhancement(mediaId, params)` — sharp pipeline with gamma, sharpen, median, saturation, withMetadata, JPEG q90
- [x] 3.6 Implement `enhanceMedia(mediaId)` — full workflow with concurrency lock, analyze → apply → save media_versions record
- [x] 3.7 Implement `isEligibleForEnhancement(qualityScore, colorScore)` predicate function
- [x] 3.8 Implement `enhanceBatch(tripId, filters)` — query eligible items, process sequentially, return summary
- [x] 3.9 Write property-based tests for validateAndClampParams (Property 7) and isEligibleForEnhancement (Property 8) using fast-check
- [x] 3.10 Write property-based test for batch count invariant (Property 9)
- [x] 3.11 Write unit tests for parseAIResponse, fallback logic, and concurrency control

## 4. Enhancement API Routes

- [x] 4.1 Create `server/src/routes/enhance.ts` with POST /api/media/:mediaId/enhance endpoint
- [x] 4.2 Add POST /api/trips/:tripId/enhance endpoint for batch enhancement
- [x] 4.3 Register enhance routes in the Express app (server/src/index.ts)
- [x] 4.4 Write integration tests for both endpoints using supertest

## 5. Serialization and Aggregation Properties

- [x] 5.1 Write property-based test for ColorCastResult JSON round-trip (Property 4)
- [x] 5.2 Write property-based test for batch severity count invariant (Property 5)
