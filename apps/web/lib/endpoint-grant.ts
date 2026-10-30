import type { DescMethod } from "@console/connectors";
import { VariableStoreService } from "@console/connectors/gen/provider/variablestore/v1/variablestore_pb";
import type { Ability } from "@ocelhq/variables-ui";

export function abilityOf(reach: { serves(call: DescMethod): boolean }): Ability {
  return {
    write: reach.serves(VariableStoreService.method.setValue),
    reveal: reach.serves(VariableStoreService.method.revealValues),
  };
}
