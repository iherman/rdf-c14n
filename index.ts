/**
 * Implementation of the RDF Canonicalization Algorithm, published by the W3C RCH Working Group. 
 * See [specification](https://www.w3.org/TR/rdf-canon/) for the latest official version.
 * 
 * @copyright Ivan Herman 2023
 * 
 * @packageDocumentation
 */

import * as rdf from 'rdf-js';
import * as n3  from 'n3';

import { 
    GlobalState, Quads, hashDataset, Hash, Constants, quadsToNquads, 
    InputDataset, computeHash 
} from './lib/common';

import { C14nResult }                       from './lib/common';
import { IDIssuer }                         from './lib/issueIdentifier';
import { computeCanonicalDataset }          from './lib/canonicalization';
import { Logger, LoggerFactory, LogLevels } from './lib/logging';

export { Quads, InputDataset, C14nResult } from './lib/common';
export { Hash, BNodeId }                   from './lib/common';
export { LogLevels, Logger }               from './lib/logging';

/**
 * Just a shell around the algorithm, consisting of a state, and the call for the real implementation.
 * 
 * The variable parts of the state, as [defined in the spec](https://www.w3.org/TR/rdf-canon/#dfn-canonicalization-state), 
 * are re-initialized at a call to the canonicalize call. Ie, the same class instance can be reused to
 * {@link RDFC10#canonicalize} for different graphs.
 */
export class RDFC10 {
    private state: GlobalState;
    /**
     * @constructor
     * @param data_factory  An implementation of the generic RDF DataFactory interface, see [the specification](http://rdf.js.org/data-model-spec/#datafactory-interface). If undefined, the DataFactory of the [n3 package](https://www.npmjs.com/package/n3) is used.
     */
    constructor(data_factory?: rdf.DataFactory) {
        this.state = {
            bnode_to_quads    : {},
            hash_to_bnodes    : {},
            canonical_issuer  : new IDIssuer(),
            hash_algorithm    : Constants.HASH_ALGORITHM,
            dataFactory       : data_factory ? data_factory : n3.DataFactory,
            logger            : LoggerFactory.createLogger(LoggerFactory.DEFAULT_LOGGER),
            logger_id         : LoggerFactory.DEFAULT_LOGGER,
            maximum_recursion : Constants.DEFAULT_MAXIMUM_RECURSION,
            current_recursion : 0
        }
    }

    /**
     * Create and set a logger instance
     *  
     * @param logger 
     */
    setLogger(id: string = LoggerFactory.DEFAULT_LOGGER, level: LogLevels = LogLevels.debug): Logger | undefined {
        const new_logger = LoggerFactory.createLogger(id, level);
        if (new_logger !== undefined) {
            this.state.logger_id = id;
            this.state.logger    = new_logger;
            return new_logger;
        } else {
            return undefined
        }
    }

    /**
     * Current logger type
     */
    get logger_type(): string {
        return this.state.logger_id;
    }

    /**
     * List of available logger types.
     */
    get available_logger_types(): string[] {
        return LoggerFactory.loggerTypes();
    }

    /**
     * Set Hash algorithm. The value can be anything that the underlying openssl, as used by node.js, accepts. The default is "sha256".
     * If the algorithm is not listed as existing for openssl, the value is ignored (and an exception is thrown).
     */
    set hash_algorithm(algorithm: string) {
        if (Constants.HASH_ALGORITHMS.includes(algorithm)) {
            this.state.hash_algorithm = algorithm;
        } else {
            const error_message = `"${algorithm}" is not a valid Hash Algorithm name`;
            throw TypeError(error_message);
        }
    }
    get hash_algorithm(): string {
        return this.state.hash_algorithm;
    }

    /**
     * List of available hash algorithm names.
     */
    get available_hash_algorithms(): string[] {
        return Constants.HASH_ALGORITHMS;
    }

    /**
     * Set the maximal level of recursion this canonicalization should use. Setting this number to a reasonably low number (say, 3),
     * ensures that some "poison graphs" would not result in an unreasonably long canonicalization process.
     * See the [security consideration section](https://www.w3.org/TR/rdf-canon/#security-considerations) in the specification.
     * 
     * The default value set by this implementation is 50; any number _greater_ then this number is ignored (and an exception is thrown).
     */
    set maximum_recursion_level(level: number) {
        if (!Number.isNaN(level) && Number.isInteger(level) && level > 0 && level < Constants.DEFAULT_MAXIMUM_RECURSION) {
            this.state.maximum_recursion = level;
        } else {
            const error_message = `Required recursion level is not an integer between 0 and ${Constants.DEFAULT_MAXIMUM_RECURSION}`;
            throw RangeError(error_message);
        }
    }
    get maximum_recursion_level(): number {
        return this.state.maximum_recursion
    }

    /**
     * The system-wide maximum value for the recursion level. The current maximum recursion level cannot exceed this value.
     */
    get maximum_allowed_recursion_level(): number {
        return Constants.DEFAULT_MAXIMUM_RECURSION;
    }

    /**
     * Canonicalize a Dataset into an N-Quads document.
     * 
     * Implementation of the main algorithmic steps, see
     * [separate overview in the spec](https://www.w3.org/TR/rdf-canon/#canon-algo-overview). The
     * real work is done in the [separate function](../functions/lib_canonicalization.computeCanonicalDataset.html).
     * 
     * @remarks
     * Note that the N-Quads parser throws an exception in case of syntax error.
     * 
     * @param input_dataset 
     * @returns - N-Quads document using the canonical ID-s.
     * 
     */
    canonicalize(input_dataset: InputDataset): string {
        return this.canonicalizeDetailed(input_dataset).canonical_form;
    }

    /**
     * Canonicalize a Dataset into a full set of information.
     * 
     * Implementation of the main algorithmic steps, see
     * [separate overview in the spec](https://www.w3.org/TR/rdf-canon/#canon-algo-overview). The
     * real work is done in the [separate function](../functions/lib_canonicalization.computeCanonicalDataset.html).
     * 
     * The result is an Object containing the serialized version and the Quads version of the canonicalization result, 
     * as well as a bnode mapping from the original to the canonical equivalents
     * 
     * @remarks
     * Note that the N-Quads parser throws an exception in case of syntax error.
     * 
     * @param input_dataset 
     * @returns - Detailed results of the canonicalization
     */
    canonicalizeDetailed(input_dataset: InputDataset): C14nResult {
        return computeCanonicalDataset(this.state, input_dataset);
    } 

    /**
     * Serialize the dataset into a (possibly sorted) Array of nquads.
     * 
     * @param input_dataset 
     * @param sort If `true` (the default) the array is lexicographically sorted
     * @returns 
     */
    toNquads(input_dataset: Quads, sort: boolean = true): string[] {
        return quadsToNquads(input_dataset, sort);
    }

    /**
     * Hash a dataset:
     * 
     * 1. Serialize the dataset into nquads and sort the result (unless the input is an N-Quads document)
     * 2. Compute the hash of the concatenated nquads.
     * 
     * This method is typically used on the result of the canonicalization to compute the canonical hash of a dataset.
     * 
     * @param input_dataset 
     * @returns
     */
    hash(input_dataset: InputDataset): Hash {
        if (typeof input_dataset === 'string') {
            return computeHash(this.state, input_dataset);
        } else {
            return hashDataset(this.state, input_dataset, true);
        }
    }
}

/** 
 * Alternative name for {@link RDFC10}.
 * 
 * @remark
 * This is only for possible backward compatibility's sake; this was the old name of the class
 * The WG has decided what the final name of the algorithm is (RDFC 1.0), hence the renaming of the core
 * class.
 */
export class RDFCanon extends RDFC10 {};
