/**
 * 工具模块统一导出。
 */

// Bash 权限管线
export { analyzeBashAstForSecurity, analyzeBashSemantics, type SimpleCommand, type ParseForSecurityResult } from "./bash/ast-parser";
export { checkSemanticsDetailed, getDangerousPatternCount, SemanticCheckCategory, type SemanticCheckResult } from "./bash/semantic-check";
export { checkBashPermission, createBashPermissionContext, PermissionRuleBehavior, type PermissionRule, type BashPermissionContext } from "./bash/permission";
export { extractPathsFromCommand, extractAllPaths, filterOutFlags, type PathExtractionResult } from "./bash/path-extractors";
export { sedCommandIsAllowed } from "./bash/sed-validator";
export { sanitizeEnvVars, type EnvSanitizationOptions, type EnvVarSanitizationResult } from "./bash/env-sanitizer";
export { interpretExitCode, extractCommandName, isSemanticError, type SemanticExitCode, type ExitCodeInterpretation } from "./bash/exit-code-semantics";
export { createBashTool, BashInputSchema, type BashInput, type BashOutput, type BashToolConfig } from "./bash/bash";

// 文件工具
export { createFileReadTool, FileReadInputSchema, type FileReadInput, type FileReadOutput } from "./file/read";
export { createFileWriteTool, createMemoryReadFileState, FileWriteInputSchema, type FileWriteInput, type FileWriteOutput, type ReadFileState } from "./file/write";
export { createFileEditTool, FileEditInputSchema, type FileEditInput, type FileEditOutput } from "./file/edit";
export { createGlobTool, GlobInputSchema, type GlobInput, type GlobOutput } from "./file/glob";

// 安全工具
export { compileSafeRegex, clearRegexCache, type SafeRegexCompileResult } from "./security/regex-safe";
export { safeEqualSecret } from "./security/secret";
export { detectToolCallLoop, hashToolCall, type ToolCallRecord, type LoopDetectionResult, type LoopDetectionConfig } from "./security/loop-detector";

// 内置工具
export { createBuiltinTools, createBuiltinToolRegistry, getBuiltinToolNames, type BuiltinToolsConfig } from "./builtin";
