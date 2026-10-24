import { schemaFrom } from "@red-cup-engineering/json-schema-services-section/contracts";
import { proofTargetSchema, leanCheckResultSchema } from "./schema.mjs";

const text = {type:"string",minLength:1};
const qualified = {type:"string",pattern:"^[A-Za-z_][A-Za-z0-9_']*(?:\\.[A-Za-z_][A-Za-z0-9_']*)*$"};
const commonProofProperties = {
  project:text,
  hints:{type:"array",maxItems:32,items:qualified},
  proposalFiles:{type:"array",maxItems:16,uniqueItems:true,items:{type:"string",pattern:"^proofs/.+\\.(?:tactic|leanproof)$"}},
  maxAttempts:{type:"integer",minimum:1,maximum:64},
  timeoutMs:{type:"integer",minimum:1000,maximum:180000},
};
export const leanProofSearchRequestSchema = {
  $id:"lean/proof-search-request",title:"LeanProofSearchRequest",
  oneOf:[
    {type:"object",additionalProperties:false,required:["project","file","declaration"],
      properties:{
        ...commonProofProperties,
        file:{type:"string",pattern:"\\.lean$"},declaration:qualified,
        proofTarget:proofTargetSchema,
        blueprintLabel:{type:"string",pattern:"^[a-z]+:[a-z0-9-]+$"},
      }},
    {type:"object",additionalProperties:false,required:["project","taskDirectory"],
      properties:{
        ...commonProofProperties,
        taskDirectory:text,
      }},
  ],
};
export const leanProofSearchResultSchema = {
  $id:"lean/proof-search-result",title:"LeanProofSearchResult",
  type:"object",required:["kind","id","state","attempts","sourceDigest","venueAccepted"],
  properties:{
    kind:{const:"metroplat.lean.proof-search-result"},
    id:text,state:{enum:["candidate-compiled","unresolved","failed"]},
    file:text,project:text,declaration:qualified,sourceDigest:text,candidateDigest:text,
    axiomReadout:{type:"string"},mainLean:{type:"string"},
    sourceProposals:{type:"array",items:{type:"object",required:["path","digest"],
      properties:{path:text,digest:text}}},
    task:{type:"object",required:["taskId","taskMode","sourceTheorem","challengeDigest","manifestDigest"],
      properties:{taskId:text,taskMode:text,sourceTheorem:text,challengeDigest:text,manifestDigest:text,
        environmentIdentity:text,dependencyIdentity:text}},
    axioms:{type:"array",items:qualified},
    proofTarget:leanCheckResultSchema.properties.proofTarget,
    candidateSource:{type:"string"},proofProgram:{type:"string"},proofTerm:{type:"string"},
    hints:{type:"array",items:qualified},
    attempts:{type:"array",items:{type:"object",required:["index","program","state"],
      properties:{index:{type:"integer"},program:text,state:text,diagnostic:{type:"string"},openGoals:{type:"array",items:text},axioms:{type:"array",items:qualified},
        sourceProposals:{type:"array",items:{type:"object",required:["path","digest"],properties:{path:text,digest:text}}},
        proofTargetStatus:{type:"string"}}}},
    frontier:{type:"array",items:{type:"object",required:["program","openGoals"],
      properties:{program:text,openGoals:{type:"array",items:text}}}},
    venueAccepted:{const:false},
    started:text,ended:text,note:{type:"string"},
  },
};
export const leanProofSearchRequestContract = schemaFrom(leanProofSearchRequestSchema);
export const leanProofSearchResultContract = schemaFrom(leanProofSearchResultSchema);
