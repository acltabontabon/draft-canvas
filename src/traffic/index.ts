export * from './types';
export { analyzeTraffic } from './analyze';
export { trafficGroupOf, trafficRoleOf, mayHaveTraffic } from './eligibility';
export { canTakeDown, lostBy, mayTakeDown, outageOf, waitsOn, type Outage, type OutageEdgeState, type OutageFix, type OutageNote, type OutageState, type OutageTarget } from './outage';
