/**
 * Validation layer for tool arguments.
 * Provides schema validation, type coercion, and error messages for all MCP tool inputs.
 * Replaces ad-hoc String()/Number() casting with structured validation.
 */

export interface ValidationError {
  field: string;
  message: string;
}

export interface ValidationResult<T> {
  ok: boolean;
  data?: T;
  errors?: ValidationError[];
}

/**
 * Brain Query validation schema
 */
export interface BrainQueryArgs {
  query: string;
  type?: string;
  limit?: number;
}

export function validateBrainQuery(args: Record<string, unknown>): ValidationResult<BrainQueryArgs> {
  const errors: ValidationError[] = [];

  // Query is required and must be a non-empty string
  const query = args["query"];
  if (typeof query !== "string") {
    errors.push({ field: "query", message: "query must be a string" });
  } else if (query.trim().length === 0) {
    errors.push({ field: "query", message: "query cannot be empty" });
  }

  // Type filter is optional but must be one of the known types
  const type = args["type"];
  if (type !== undefined && type !== null) {
    const typeStr = String(type);
    const validTypes = ["identity", "semantic", "episodic", "pattern", "skill", "goal", "emotion", "procedural", "schema"];
    if (!validTypes.includes(typeStr)) {
      errors.push({ field: "type", message: `type must be one of: ${validTypes.join(", ")}` });
    }
  }

  // Limit is optional but must be a positive integer
  let limit: number | undefined;
  if (args["limit"] !== undefined && args["limit"] !== null) {
    const numLimit = Number(args["limit"]);
    if (!Number.isInteger(numLimit) || numLimit <= 0) {
      errors.push({ field: "limit", message: "limit must be a positive integer" });
    } else if (numLimit > 1000) {
      errors.push({ field: "limit", message: "limit cannot exceed 1000" });
    } else {
      limit = numLimit;
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    data: {
      query: (query as string).trim(),
      type: type ? String(type) : undefined,
      limit: limit ?? 10,
    },
  };
}

/**
 * Brain Write validation schema
 */
export interface BrainWriteArgs {
  type: string;
  label: string;
  content: string;
  importance?: number;
  emotional_weight?: number;
}

export function validateBrainWrite(args: Record<string, unknown>): ValidationResult<BrainWriteArgs> {
  const errors: ValidationError[] = [];

  // Type is required
  const type = args["type"];
  if (typeof type !== "string") {
    errors.push({ field: "type", message: "type must be a string" });
  } else {
    const validTypes = ["identity", "semantic", "episodic", "pattern", "skill", "goal", "emotion", "procedural", "schema"];
    if (!validTypes.includes(type)) {
      errors.push({ field: "type", message: `type must be one of: ${validTypes.join(", ")}` });
    }
  }

  // Label is required and non-empty
  const label = args["label"];
  if (typeof label !== "string") {
    errors.push({ field: "label", message: "label must be a string" });
  } else if (label.trim().length === 0) {
    errors.push({ field: "label", message: "label cannot be empty" });
  } else if (label.length > 500) {
    errors.push({ field: "label", message: "label cannot exceed 500 characters" });
  }

  // Content is required and non-empty
  const content = args["content"];
  if (typeof content !== "string") {
    errors.push({ field: "content", message: "content must be a string" });
  } else if (content.trim().length === 0) {
    errors.push({ field: "content", message: "content cannot be empty" });
  } else if (content.length > 100000) {
    errors.push({ field: "content", message: "content cannot exceed 100,000 characters" });
  }

  // Importance is optional, must be 0.0-1.0
  let importance: number | undefined;
  if (args["importance"] !== undefined && args["importance"] !== null) {
    const imp = Number(args["importance"]);
    if (!Number.isFinite(imp) || imp < 0 || imp > 1) {
      errors.push({ field: "importance", message: "importance must be a number between 0.0 and 1.0" });
    } else {
      importance = imp;
    }
  }

  // Emotional weight is optional, must be -1.0 to 1.0
  let emotional_weight: number | undefined;
  if (args["emotional_weight"] !== undefined && args["emotional_weight"] !== null) {
    const ew = Number(args["emotional_weight"]);
    if (!Number.isFinite(ew) || ew < -1 || ew > 1) {
      errors.push({ field: "emotional_weight", message: "emotional_weight must be a number between -1.0 and 1.0" });
    } else {
      emotional_weight = ew;
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    data: {
      type: type as string,
      label: (label as string).trim(),
      content: (content as string).trim(),
      importance,
      emotional_weight,
    },
  };
}

/**
 * Brain Link validation schema
 */
export interface BrainLinkArgs {
  from_id: string;
  to_id: string;
  edge_type: string;
  weight?: number;
}

export function validateBrainLink(args: Record<string, unknown>): ValidationResult<BrainLinkArgs> {
  const errors: ValidationError[] = [];

  // from_id is required and must be a non-empty string
  const from_id = args["from_id"];
  if (typeof from_id !== "string") {
    errors.push({ field: "from_id", message: "from_id must be a string" });
  } else if (from_id.trim().length === 0) {
    errors.push({ field: "from_id", message: "from_id cannot be empty" });
  }

  // to_id is required and must be a non-empty string
  const to_id = args["to_id"];
  if (typeof to_id !== "string") {
    errors.push({ field: "to_id", message: "to_id must be a string" });
  } else if (to_id.trim().length === 0) {
    errors.push({ field: "to_id", message: "to_id cannot be empty" });
  }

  // Check that from_id and to_id are different
  if (from_id === to_id) {
    errors.push({ field: "to_id", message: "from_id and to_id cannot be the same" });
  }

  // edge_type is required
  const edge_type = args["edge_type"];
  if (typeof edge_type !== "string") {
    errors.push({ field: "edge_type", message: "edge_type must be a string" });
  } else {
    const validEdges = [
      "caused_by", "associates", "supports", "instance_of", "goal_of", "before",
      "after", "inhibits", "summarizes", "attaches_to", "contradicts", "supersedes",
      "coreference_of",
    ];
    if (!validEdges.includes(edge_type)) {
      errors.push({ field: "edge_type", message: `edge_type must be one of: ${validEdges.join(", ")}` });
    }
  }

  // Weight is optional, must be 0.0-1.0
  let weight: number | undefined;
  if (args["weight"] !== undefined && args["weight"] !== null) {
    const w = Number(args["weight"]);
    if (!Number.isFinite(w) || w < 0 || w > 1) {
      errors.push({ field: "weight", message: "weight must be a number between 0.0 and 1.0" });
    } else {
      weight = w;
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    data: {
      from_id: (from_id as string).trim(),
      to_id: (to_id as string).trim(),
      edge_type: (edge_type as string).trim(),
      weight,
    },
  };
}

/**
 * Brain Supersede validation schema
 */
export interface BrainSupersedArgs {
  old_node_id: string;
  new_content: string;
  new_label?: string;
}

export function validateBrainSupersede(args: Record<string, unknown>): ValidationResult<BrainSupersedArgs> {
  const errors: ValidationError[] = [];

  // old_node_id is required
  const old_node_id = args["old_node_id"];
  if (typeof old_node_id !== "string") {
    errors.push({ field: "old_node_id", message: "old_node_id must be a string" });
  } else if (old_node_id.trim().length === 0) {
    errors.push({ field: "old_node_id", message: "old_node_id cannot be empty" });
  }

  // new_content is required and non-empty
  const new_content = args["new_content"];
  if (typeof new_content !== "string") {
    errors.push({ field: "new_content", message: "new_content must be a string" });
  } else if (new_content.trim().length === 0) {
    errors.push({ field: "new_content", message: "new_content cannot be empty" });
  } else if (new_content.length > 100000) {
    errors.push({ field: "new_content", message: "new_content cannot exceed 100,000 characters" });
  }

  // new_label is optional but if provided must be non-empty
  let new_label: string | undefined;
  if (args["new_label"] !== undefined && args["new_label"] !== null) {
    const nl = String(args["new_label"]);
    if (nl.trim().length === 0) {
      errors.push({ field: "new_label", message: "new_label cannot be empty" });
    } else if (nl.length > 500) {
      errors.push({ field: "new_label", message: "new_label cannot exceed 500 characters" });
    } else {
      new_label = nl.trim();
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    data: {
      old_node_id: (old_node_id as string).trim(),
      new_content: (new_content as string).trim(),
      new_label,
    },
  };
}

/**
 * Brain History validation schema
 */
export interface BrainHistoryArgs {
  query: string;
  since?: number;
  until?: number;
  limit?: number;
}

export function validateBrainHistory(args: Record<string, unknown>): ValidationResult<BrainHistoryArgs> {
  const errors: ValidationError[] = [];

  // Query is required
  const query = args["query"];
  if (typeof query !== "string") {
    errors.push({ field: "query", message: "query must be a string" });
  } else if (query.trim().length === 0) {
    errors.push({ field: "query", message: "query cannot be empty" });
  }

  // Since is optional, must be a positive Unix timestamp
  let since: number | undefined;
  if (args["since"] !== undefined && args["since"] !== null) {
    const s = Number(args["since"]);
    if (!Number.isInteger(s) || s < 0) {
      errors.push({ field: "since", message: "since must be a positive integer (Unix timestamp in ms)" });
    } else {
      since = s;
    }
  }

  // Until is optional, must be a positive Unix timestamp
  let until: number | undefined;
  if (args["until"] !== undefined && args["until"] !== null) {
    const u = Number(args["until"]);
    if (!Number.isInteger(u) || u < 0) {
      errors.push({ field: "until", message: "until must be a positive integer (Unix timestamp in ms)" });
    } else {
      until = u;
    }
  }

  // Validate since < until
  if (since !== undefined && until !== undefined && since >= until) {
    errors.push({ field: "until", message: "until must be greater than since" });
  }

  // Limit is optional, must be a positive integer
  let limit: number | undefined;
  if (args["limit"] !== undefined && args["limit"] !== null) {
    const lim = Number(args["limit"]);
    if (!Number.isInteger(lim) || lim <= 0) {
      errors.push({ field: "limit", message: "limit must be a positive integer" });
    } else if (lim > 1000) {
      errors.push({ field: "limit", message: "limit cannot exceed 1000" });
    } else {
      limit = lim;
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    data: {
      query: (query as string).trim(),
      since,
      until,
      limit: limit ?? 10,
    },
  };
}

/**
 * Brain Expand validation schema
 */
export interface BrainExpandArgs {
  node_id: string;
}

export function validateBrainExpand(args: Record<string, unknown>): ValidationResult<BrainExpandArgs> {
  const errors: ValidationError[] = [];

  const node_id = args["node_id"];
  if (typeof node_id !== "string") {
    errors.push({ field: "node_id", message: "node_id must be a string" });
  } else if (node_id.trim().length === 0) {
    errors.push({ field: "node_id", message: "node_id cannot be empty" });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    data: {
      node_id: (node_id as string).trim(),
    },
  };
}

/**
 * Brain Review validation schema
 */
export interface BrainReviewArgs {
  node_id: string;
  quality: number;
}

export function validateBrainReview(args: Record<string, unknown>): ValidationResult<BrainReviewArgs> {
  const errors: ValidationError[] = [];

  const node_id = args["node_id"];
  if (typeof node_id !== "string") {
    errors.push({ field: "node_id", message: "node_id must be a string" });
  } else if (node_id.trim().length === 0) {
    errors.push({ field: "node_id", message: "node_id cannot be empty" });
  }

  const quality = Number(args["quality"] ?? 3);
  if (!Number.isInteger(quality) || quality < 0 || quality > 5) {
    errors.push({ field: "quality", message: "quality must be an integer between 0 and 5" });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    data: {
      node_id: (node_id as string).trim(),
      quality,
    },
  };
}

/**
 * Brain Forget validation schema
 */
export interface BrainForgetArgs {
  node_id: string;
  force?: boolean;
}

export function validateBrainForget(args: Record<string, unknown>): ValidationResult<BrainForgetArgs> {
  const errors: ValidationError[] = [];

  const node_id = args["node_id"];
  if (typeof node_id !== "string") {
    errors.push({ field: "node_id", message: "node_id must be a string" });
  } else if (node_id.trim().length === 0) {
    errors.push({ field: "node_id", message: "node_id cannot be empty" });
  }

  const force = args["force"] ? Boolean(args["force"]) : false;

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    data: {
      node_id: (node_id as string).trim(),
      force,
    },
  };
}

/**
 * Brain Edges validation schema
 */
export interface BrainEdgesArgs {
  node_id: string;
}

export function validateBrainEdges(args: Record<string, unknown>): ValidationResult<BrainEdgesArgs> {
  const errors: ValidationError[] = [];

  const node_id = args["node_id"];
  if (typeof node_id !== "string") {
    errors.push({ field: "node_id", message: "node_id must be a string" });
  } else if (node_id.trim().length === 0) {
    errors.push({ field: "node_id", message: "node_id cannot be empty" });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    data: {
      node_id: (node_id as string).trim(),
    },
  };
}

/**
 * Format validation errors for user display
 */
export function formatValidationErrors(errors: ValidationError[]): string {
  return errors.map((e) => `${e.field}: ${e.message}`).join("\n");
}
