/**
 * 通信模块统一导出。
 */

// Identity
export {
  createIdentity,
  createMessageSigner,
  type Identity,
  type MessageSigner,
  type IdentityPublicData,
  type SignatureAlgorithm,
  type SignatureResult,
  type VerifyResult,
} from "./identity";

// Protocol
export {
  validatePeerMessage,
  isMessageExpired,
  createPeerMessage,
  createPeerInfo,
  isPeerAlive,
  getPeerBaseUrl,
  PeerMessageSchema,
  PeerMessageTypeSchema,
  PEER_MESSAGE_TYPES,
  type PeerMessage,
  type PeerMessageInput,
  type PeerMessageType,
  type PeerInfo,
  type MessageValidationResult,
} from "./protocol";

// Client
export {
  createP2PClient,
  type P2PClient,
  type P2PResponse,
  type P2PClientConfig,
} from "./client";

// Dedup
export {
  createBoundedUUIDSet,
  type BoundedUUIDSet,
} from "./dedup";

// Rate Limiter
export {
  createRateLimiter,
  type RateLimiter,
  type RateLimiterCheck,
  type RateLimiterConfig,
} from "./rate-limiter";

// Consensus
export {
  createConsensusEngine,
  type ConsensusEngine,
  type Endorsement,
  type EndorsementVerdict,
  type EndorsementTargetType,
  type ConsensusScore,
} from "./consensus";

// Anomaly
export {
  createAnomalyDetector,
  type AnomalyDetector,
  type AnomalyRecord,
  type AnomalyCheckResult,
  type AnomalySeverity,
} from "./anomaly";

// Reputation
export {
  createReputationSystem,
  type ReputationSystem,
  type ReputationData,
  type ReputationTier,
} from "./reputation";

// Critic
export {
  createCritic,
  type Critic,
  type ExternalKnowledge,
  type ProcessingResult,
} from "./critic";

// Marketplace
export {
  createMarketplace,
  type Marketplace,
  type MarketItem,
  type MarketItemType,
  type MarketItemStatus,
  type MarketDifficulty,
  type MarketSearchOptions,
} from "./marketplace";

// Community
export {
  createCommunity,
  type Community,
  type GovernanceProposal,
  type ProposalType,
  type ProposalStatus,
  type VoteResult,
} from "./community";

// Analytics
export {
  createAnalytics,
  type Analytics,
  type AnalyticsSummary,
  type TrendDataPoint,
} from "./analytics";

// Gateway
export {
  createGateway,
  type Gateway,
  type GatewayConfig,
  type GatewayStats,
  type MessageHandleResult,
} from "./gateway";
