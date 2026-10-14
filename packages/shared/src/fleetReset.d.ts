import { z } from 'zod';
/** This private contract never grants filesystem or command execution authority. */
export declare const FLEET_RESET_CONTRACT: "propr.fleet-reset.v1";
export declare const FLEET_RESET_AUDIENCE: "fleet-reset-coordinator";
export declare const FLEET_RESET_PATH: "/reset/v1/invoke";
export declare const FLEET_RESET_CATEGORIES: readonly ["database", "configuration", "repositories_worktrees_caches", "active_tasks", "queued_tasks", "unpublished_results", "provider_sessions", "tunnel_bootstrap", "diagnostic_logs"];
export declare const FLEET_RESET_LIMITS: {
    readonly requestBytes: 8192;
    readonly responseBytes: 16384;
    readonly grantSeconds: 30;
    readonly entries: 16384;
};
export declare const fleetResetIdentitySchema: z.ZodObject<{
    generation: z.ZodNumber;
    stateScope: z.ZodString;
    runtimeId: z.ZodString;
    storageId: z.ZodString;
}, z.core.$strict>;
export declare const fleetResetBindingSchema: z.ZodObject<{
    resetOperationId: z.ZodString;
    resetRequestDigest: z.ZodString;
    resetAction: z.ZodLiteral<"instance.reset">;
    instanceId: z.ZodString;
    predecessor: z.ZodObject<{
        generation: z.ZodNumber;
        stateScope: z.ZodString;
        runtimeId: z.ZodString;
        storageId: z.ZodString;
    }, z.core.$strict>;
    successor: z.ZodObject<{
        generation: z.ZodNumber;
        stateScope: z.ZodString;
        runtimeId: z.ZodString;
        storageId: z.ZodString;
    }, z.core.$strict>;
    runtimeBuildDigest: z.ZodString;
}, z.core.$strict>;
export declare const fleetResetAssertionSchema: z.ZodObject<{
    contract: z.ZodLiteral<"propr.fleet-reset.v1">;
    contractPin: z.ZodString;
    audience: z.ZodLiteral<"fleet-reset-coordinator">;
    binding: z.ZodObject<{
        resetOperationId: z.ZodString;
        resetRequestDigest: z.ZodString;
        resetAction: z.ZodLiteral<"instance.reset">;
        instanceId: z.ZodString;
        predecessor: z.ZodObject<{
            generation: z.ZodNumber;
            stateScope: z.ZodString;
            runtimeId: z.ZodString;
            storageId: z.ZodString;
        }, z.core.$strict>;
        successor: z.ZodObject<{
            generation: z.ZodNumber;
            stateScope: z.ZodString;
            runtimeId: z.ZodString;
            storageId: z.ZodString;
        }, z.core.$strict>;
        runtimeBuildDigest: z.ZodString;
    }, z.core.$strict>;
    action: z.ZodEnum<{
        "reset.prove": "reset.prove";
        "reset.receipt": "reset.receipt";
    }>;
    requestId: z.ZodString;
    nonce: z.ZodString;
    issuedAt: z.ZodNumber;
    expiresAt: z.ZodNumber;
}, z.core.$strict>;
export declare const fleetResetEnvelopeSchema: z.ZodObject<{
    assertion: z.ZodObject<{
        contract: z.ZodLiteral<"propr.fleet-reset.v1">;
        contractPin: z.ZodString;
        audience: z.ZodLiteral<"fleet-reset-coordinator">;
        binding: z.ZodObject<{
            resetOperationId: z.ZodString;
            resetRequestDigest: z.ZodString;
            resetAction: z.ZodLiteral<"instance.reset">;
            instanceId: z.ZodString;
            predecessor: z.ZodObject<{
                generation: z.ZodNumber;
                stateScope: z.ZodString;
                runtimeId: z.ZodString;
                storageId: z.ZodString;
            }, z.core.$strict>;
            successor: z.ZodObject<{
                generation: z.ZodNumber;
                stateScope: z.ZodString;
                runtimeId: z.ZodString;
                storageId: z.ZodString;
            }, z.core.$strict>;
            runtimeBuildDigest: z.ZodString;
        }, z.core.$strict>;
        action: z.ZodEnum<{
            "reset.prove": "reset.prove";
            "reset.receipt": "reset.receipt";
        }>;
        requestId: z.ZodString;
        nonce: z.ZodString;
        issuedAt: z.ZodNumber;
        expiresAt: z.ZodNumber;
    }, z.core.$strict>;
    mac: z.ZodString;
}, z.core.$strict>;
export type FleetResetBinding = z.infer<typeof fleetResetBindingSchema>;
export type FleetResetAssertion = z.infer<typeof fleetResetAssertionSchema>;
export type FleetResetEnvelope = z.infer<typeof fleetResetEnvelopeSchema>;
/** No success variant until native runtime coverage has been implemented and qualified.
 * In particular, a caller cannot turn executor booleans into guest proof. */
export declare const fleetResetEvidenceSchema: z.ZodObject<{
    state: z.ZodLiteral<"recovery_required">;
    categories: z.ZodObject<{
        database: z.ZodLiteral<"unproven">;
        configuration: z.ZodLiteral<"unproven">;
        repositories_worktrees_caches: z.ZodLiteral<"unproven">;
        active_tasks: z.ZodLiteral<"unproven">;
        queued_tasks: z.ZodLiteral<"unproven">;
        unpublished_results: z.ZodLiteral<"unproven">;
        provider_sessions: z.ZodLiteral<"unproven">;
        tunnel_bootstrap: z.ZodLiteral<"unproven">;
        diagnostic_logs: z.ZodLiteral<"unproven">;
    }, z.core.$strict>;
    predecessorFenced: z.ZodLiteral<false>;
    successorIsolated: z.ZodLiteral<false>;
    bootstrapAllowed: z.ZodLiteral<false>;
    reason: z.ZodEnum<{
        native_coverage_unavailable: "native_coverage_unavailable";
        interrupted_or_corrupt: "interrupted_or_corrupt";
    }>;
}, z.core.$strict>;
export declare const fleetResetReceiptSchema: z.ZodObject<{
    contract: z.ZodLiteral<"propr.fleet-reset.v1">;
    contractPin: z.ZodString;
    audience: z.ZodLiteral<"fleet-reset-coordinator">;
    binding: z.ZodObject<{
        resetOperationId: z.ZodString;
        resetRequestDigest: z.ZodString;
        resetAction: z.ZodLiteral<"instance.reset">;
        instanceId: z.ZodString;
        predecessor: z.ZodObject<{
            generation: z.ZodNumber;
            stateScope: z.ZodString;
            runtimeId: z.ZodString;
            storageId: z.ZodString;
        }, z.core.$strict>;
        successor: z.ZodObject<{
            generation: z.ZodNumber;
            stateScope: z.ZodString;
            runtimeId: z.ZodString;
            storageId: z.ZodString;
        }, z.core.$strict>;
        runtimeBuildDigest: z.ZodString;
    }, z.core.$strict>;
    action: z.ZodEnum<{
        "reset.prove": "reset.prove";
        "reset.receipt": "reset.receipt";
    }>;
    requestId: z.ZodString;
    requestDigest: z.ZodString;
    proofRequestId: z.ZodNullable<z.ZodString>;
    evidenceDigest: z.ZodString;
    observedAt: z.ZodNumber;
    expiresAt: z.ZodNumber;
    evidence: z.ZodObject<{
        state: z.ZodLiteral<"recovery_required">;
        categories: z.ZodObject<{
            database: z.ZodLiteral<"unproven">;
            configuration: z.ZodLiteral<"unproven">;
            repositories_worktrees_caches: z.ZodLiteral<"unproven">;
            active_tasks: z.ZodLiteral<"unproven">;
            queued_tasks: z.ZodLiteral<"unproven">;
            unpublished_results: z.ZodLiteral<"unproven">;
            provider_sessions: z.ZodLiteral<"unproven">;
            tunnel_bootstrap: z.ZodLiteral<"unproven">;
            diagnostic_logs: z.ZodLiteral<"unproven">;
        }, z.core.$strict>;
        predecessorFenced: z.ZodLiteral<false>;
        successorIsolated: z.ZodLiteral<false>;
        bootstrapAllowed: z.ZodLiteral<false>;
        reason: z.ZodEnum<{
            native_coverage_unavailable: "native_coverage_unavailable";
            interrupted_or_corrupt: "interrupted_or_corrupt";
        }>;
    }, z.core.$strict>;
}, z.core.$strict>;
export declare const fleetResetSignedReceiptSchema: z.ZodObject<{
    receipt: z.ZodObject<{
        contract: z.ZodLiteral<"propr.fleet-reset.v1">;
        contractPin: z.ZodString;
        audience: z.ZodLiteral<"fleet-reset-coordinator">;
        binding: z.ZodObject<{
            resetOperationId: z.ZodString;
            resetRequestDigest: z.ZodString;
            resetAction: z.ZodLiteral<"instance.reset">;
            instanceId: z.ZodString;
            predecessor: z.ZodObject<{
                generation: z.ZodNumber;
                stateScope: z.ZodString;
                runtimeId: z.ZodString;
                storageId: z.ZodString;
            }, z.core.$strict>;
            successor: z.ZodObject<{
                generation: z.ZodNumber;
                stateScope: z.ZodString;
                runtimeId: z.ZodString;
                storageId: z.ZodString;
            }, z.core.$strict>;
            runtimeBuildDigest: z.ZodString;
        }, z.core.$strict>;
        action: z.ZodEnum<{
            "reset.prove": "reset.prove";
            "reset.receipt": "reset.receipt";
        }>;
        requestId: z.ZodString;
        requestDigest: z.ZodString;
        proofRequestId: z.ZodNullable<z.ZodString>;
        evidenceDigest: z.ZodString;
        observedAt: z.ZodNumber;
        expiresAt: z.ZodNumber;
        evidence: z.ZodObject<{
            state: z.ZodLiteral<"recovery_required">;
            categories: z.ZodObject<{
                database: z.ZodLiteral<"unproven">;
                configuration: z.ZodLiteral<"unproven">;
                repositories_worktrees_caches: z.ZodLiteral<"unproven">;
                active_tasks: z.ZodLiteral<"unproven">;
                queued_tasks: z.ZodLiteral<"unproven">;
                unpublished_results: z.ZodLiteral<"unproven">;
                provider_sessions: z.ZodLiteral<"unproven">;
                tunnel_bootstrap: z.ZodLiteral<"unproven">;
                diagnostic_logs: z.ZodLiteral<"unproven">;
            }, z.core.$strict>;
            predecessorFenced: z.ZodLiteral<false>;
            successorIsolated: z.ZodLiteral<false>;
            bootstrapAllowed: z.ZodLiteral<false>;
            reason: z.ZodEnum<{
                native_coverage_unavailable: "native_coverage_unavailable";
                interrupted_or_corrupt: "interrupted_or_corrupt";
            }>;
        }, z.core.$strict>;
    }, z.core.$strict>;
    mac: z.ZodString;
}, z.core.$strict>;
export type FleetResetEvidence = z.infer<typeof fleetResetEvidenceSchema>;
export type FleetResetReceipt = z.infer<typeof fleetResetReceiptSchema>;
export declare const FLEET_RESET_SCHEMA: string;
