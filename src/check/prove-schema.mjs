import { schemaFrom } from "@red-cup-engineering/json-schema-services-section/contracts";
import { proofTargetSchema, leanCheckResultSchema } from "./schema.mjs";

const text = {type:"string",minLength:1};
const qualified = {type:"string",pattern:"^[A-Za-z_][A-Za-z0-9_']*(?:\\.[A-Za-z_][A-Za-z0-9_']*)*$"};
export const leanProofSearchRequestSchema = {
  $id:"lean/proof-search-request",title:"LeanProofSearchRequest",
  type:"object",additionalProperties:false,required:["project","file","declaration"],
  properties:{
    project:text,file:{type:"string",pattern:"\\.lean$"},declaration:qualified,
    proofTarget:proofTargetSchema,
    blueprintLabel:{type:"string",pattern:"^[a-z]+:[a-z0-9-]+$"},
    hints:{type:"array",maxItems:32,items:qualified},
    maxAttempts:{type:"integer",minimum:1,maximum:64},
    timeoutMs:{type:"integer",minimum:1000,maximum:180000},
  },
};
export const leanProofSearchResultSchema = {
  $id:"lean/proof-search-result",title:"LeanProofSearchResult",
  type:"object",required:["kind","id","state","attempts","sourceDigest","venueAccepted"],
  properties:{
    kind:{const:"metroplat.lean.proof-search-result"},
    id:text,state:{enum:["candidate-compiled","unresolved","failed"]},
    file:text,project:text,declaration:qualified,sourceDigest:text,candidateDigest:text,
    axiomReadout:{type:"string"},
    axioms:{type:"array",items:qualified},
    proofTarget:leanCheckResultSchema.properties.proofTarget,
    candidateSource:{type:"string"},proofProgram:{type:"string"},proofTerm:{type:"string"},
    hints:{type:"array",items:qualified},
    attempts:{type:"array",items:{type:"object",required:["index","program","state"],
      properties:{index:{type:"integer"},program:text,state:text,diagnostic:{type:"string"},openGoals:{type:"array",items:text},axioms:{type:"array",items:qualified},
        proofTargetStatus:{type:"string"}}}},
    frontier:{type:"array",items:{type:"object",required:["program","openGoals"],
      properties:{program:text,openGoals:{type:"array",items:text}}}},
    venueAccepted:{const:false},
    started:text,ended:text,note:{type:"string"},
  },
};
export const leanProofSearchRequestContract = schemaFrom(leanProofSearchRequestSchema);
export const leanProofSearchResultContract = schemaFrom(leanProofSearchResultSchema);
