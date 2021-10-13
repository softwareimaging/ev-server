import FeatureToggles, { Feature } from '../../utils/FeatureToggles';
import PricingDefinition, { PricedConsumptionData, PricingStaticRestriction, ResolvedPricingModel } from '../../types/Pricing';

import ChargingStation from '../../types/ChargingStation';
import Constants from '../../utils/Constants';
import Consumption from '../../types/Consumption';
import ConsumptionPricer from './ConsumptionPricer';
import PricingStorage from '../../storage/mongodb/PricingStorage';
import Tenant from '../../types/Tenant';
import Transaction from '../../types/Transaction';
import Utils from '../../utils/Utils';
import moment from 'moment';

export default class PricingEngine {

  public static async resolvePricingContext(tenant: Tenant, transaction: Transaction, chargingStation: ChargingStation): Promise<ResolvedPricingModel> {
    // Merge the pricing definitions from the different contexts
    const pricingDefinitions: PricingDefinition[] = [];
    if (FeatureToggles.isFeatureActive(Feature.PRICING_CHECK_BACKWARD_COMPATIBILITY)) {
      // Do nothing - this should trigger a fallback to the simple pricing logic
    } else {
      // pricingDefinitions.push(...await PricingEngine.getPricingDefinitions4Entity(tenant, transaction.userID));
      pricingDefinitions.push(...await PricingEngine.getPricingDefinitions4Entity(tenant, transaction, chargingStation, transaction.chargeBoxID.toString()));
      pricingDefinitions.push(...await PricingEngine.getPricingDefinitions4Entity(tenant, transaction, chargingStation, transaction.siteAreaID.toString()));
      pricingDefinitions.push(...await PricingEngine.getPricingDefinitions4Entity(tenant, transaction, chargingStation, transaction.siteID.toString()));
      pricingDefinitions.push(...await PricingEngine.getPricingDefinitions4Entity(tenant, transaction, chargingStation, transaction.companyID.toString()));
    }
    // Return the resolution result as a resolved pricing model
    const resolvedPricingModel: ResolvedPricingModel = {
      pricerContext: {
        flatFeeAlreadyPriced: false,
        sessionStartDate: transaction.timestamp
      },
      pricingDefinitions
    };
    return Promise.resolve(resolvedPricingModel);
  }

  public static priceConsumption(tenant: Tenant, pricingModel: ResolvedPricingModel, consumptionData: Consumption): PricedConsumptionData {
    const consumptionPricer = new ConsumptionPricer(tenant, pricingModel, consumptionData);
    return consumptionPricer.priceConsumption();
  }

  public static extractFinalPricingData(pricingModel: ResolvedPricingModel): PricedConsumptionData[] {
    // Iterate throw the list of pricing definitions
    const pricedData: PricedConsumptionData[] = pricingModel.pricingDefinitions.map((pricingDefinition) =>
      PricingEngine.extractFinalPricedConsumptionData(pricingDefinition)
    );
    // Remove null/undefined entries (if any)
    return pricedData.filter((pricingConsumptionData) => !!pricingConsumptionData);
  }

  private static async getPricingDefinitions4Entity(tenant: Tenant, transaction: Transaction, chargingStation: ChargingStation, entityID: string): Promise<PricingDefinition[]> {
    let pricingDefinitions = await PricingEngine._getPricingDefinitions4Entity(tenant, entityID);
    pricingDefinitions = pricingDefinitions || [];
    const actualPricingDefinitions = pricingDefinitions.filter((pricingDefinition) =>
      PricingEngine.checkStaticRestrictions(pricingDefinition, transaction, chargingStation)
    );
    return actualPricingDefinitions || [];
  }

  private static async _getPricingDefinitions4Entity(tenant: Tenant, entityID: string): Promise<PricingDefinition[]> {
    if (entityID) {
      const entityIDs = [ entityID ];
      const pricingModelResults = await PricingStorage.getPricingDefinitions(tenant, { entityIDs }, {
        limit: Constants.DB_RECORD_COUNT_NO_LIMIT, skip: 0, sort: { createdOn: -1 }
      });
      if (pricingModelResults.count > 0) {
        return pricingModelResults.result;
      }
    }
    return null;
  }

  private static checkStaticRestrictions(pricingDefinition: PricingDefinition, transaction: Transaction, chargingStation: ChargingStation) : PricingDefinition {
    if (pricingDefinition.staticRestrictions) {
      if (
        !PricingEngine.checkDateValidity(pricingDefinition.staticRestrictions, transaction)
      || !PricingEngine.checkConnectorType(pricingDefinition.staticRestrictions, transaction, chargingStation)
      || !PricingEngine.checkConnectorPower(pricingDefinition.staticRestrictions, transaction, chargingStation)
      ) {
        return null;
      }
    }
    // a definition matching the restrictions has been found
    return pricingDefinition;
  }

  private static checkDateValidity(staticRestrictions: PricingStaticRestriction, transaction: Transaction): boolean {
    if (!Utils.isNullOrUndefined(staticRestrictions.validFrom)) {
      if (moment(transaction.timestamp).isBefore(staticRestrictions.validFrom)) {
        return false;
      }
    }
    if (!Utils.isNullOrUndefined(staticRestrictions.validTo)) {
      if (moment(transaction.timestamp).isSameOrAfter(staticRestrictions.validTo)) {
        return false;
      }
    }
    return true;
  }

  private static checkConnectorType(staticRestrictions: PricingStaticRestriction, transaction: Transaction, chargingStation: ChargingStation): boolean {
    if (!Utils.isNullOrUndefined(staticRestrictions.connectorType)) {
      const connectorType = Utils.getConnectorFromID(chargingStation, transaction.connectorId)?.type;
      if (staticRestrictions.connectorType !== connectorType) {
        return false;
      }
    }
    return true;
  }

  private static checkConnectorPower(staticRestrictions: PricingStaticRestriction, transaction: Transaction, chargingStation: ChargingStation): boolean {
    if (!Utils.isNullOrUndefined(staticRestrictions.connectorPowerkW)) {
      const connectorPowerWatts = Utils.getConnectorFromID(chargingStation, transaction.connectorId)?.power;
      if (!Utils.createDecimal(connectorPowerWatts).div(1000).equals(staticRestrictions.connectorPowerkW)) {
        return false;
      }
    }
    return true;
  }

  private static extractFinalPricedConsumptionData(pricingDefinition: PricingDefinition): PricedConsumptionData {
    const flatFee = pricingDefinition.dimensions.flatFee?.pricedData;
    const energy = pricingDefinition.dimensions.energy?.pricedData;
    const chargingTime = pricingDefinition.dimensions.chargingTime?.pricedData;
    const parkingTime = pricingDefinition.dimensions.parkingTime?.pricedData;
    if (flatFee || energy || chargingTime || parkingTime) {
      return {
        flatFee,
        energy,
        chargingTime,
        parkingTime
      };
    }
    // Nothing to bill for the current pricing definition
    return null;
  }
}
