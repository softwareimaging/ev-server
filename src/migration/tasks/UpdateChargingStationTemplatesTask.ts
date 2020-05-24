import ChargingStationStorage from '../../storage/mongodb/ChargingStationStorage';
import ChargingStationVendorFactory from '../../integration/charging-station-vendor/ChargingStationVendorFactory';
import Constants from '../../utils/Constants';
import Logging from '../../utils/Logging';
import MigrationTask from '../MigrationTask';
import { OCPPConfigurationStatus } from '../../types/ocpp/OCPPClient';
import OCPPUtils from '../../server/ocpp/utils/OCPPUtils';
import { ServerAction } from '../../types/Server';
import Tenant from '../../types/Tenant';
import TenantStorage from '../../storage/mongodb/TenantStorage';
import Utils from '../../utils/Utils';
import global from './../../types/GlobalType';

const MODULE_NAME = 'UpdateChargingStationTemplatesTask';

export default class UpdateChargingStationTemplatesTask extends MigrationTask {
  isAsynchronous() {
    return true;
  }

  getName() {
    return 'UpdateChargingStationTemplatesTask';
  }

  async migrate() {
    // Update Template
    await this.updateChargingStationTemplate();
    // Avoid migrating the current charging stations due to Schneider charge@home Wallboxes
    // Update Charging Stations
    const tenants = await TenantStorage.getTenants({}, Constants.DB_PARAMS_MAX_LIMIT);
    for (const tenant of tenants.result) {
      // Update current Charging Station with Template
      await this.applyTemplateToChargingStations(tenant);
      // Remove unused props
      await this.cleanUpChargingStationDBProps(tenant);
      // Initialize amperage limitation
      await this.initChargingStationLimitAmps(tenant);
    }
  }

  getVersion() {
    return '1.899991';
  }

  private async applyTemplateToChargingStations(tenant: Tenant) {
    let updated = 0;
    // Get the charging stations
    const chargingStations = await ChargingStationStorage.getChargingStations(tenant.id, {
      issuer: true
    }, Constants.DB_PARAMS_MAX_LIMIT);
    // Update
    for (const chargingStation of chargingStations.result) {
      // Enrich
      const chargingStationTemplateUpdated = await OCPPUtils.enrichChargingStationWithTemplate(tenant.id, chargingStation);
      let chargingStationUpdated = false;
      // Check Connectors
      for (const connector of chargingStation.connectors) {
        if (!Utils.objectHasProperty(connector, 'amperageLimit')) {
          connector.amperageLimit = connector.amperage;
          chargingStationUpdated = true;
        }
      }
      // Save
      if (chargingStationTemplateUpdated.technicalUpdated ||
          chargingStationTemplateUpdated.capabilitiesUpdated ||
          chargingStationTemplateUpdated.ocppUpdated ||
          chargingStationUpdated) {
        await ChargingStationStorage.saveChargingStation(tenant.id, chargingStation);
        updated++;
        // Retrieve OCPP params and update them if needed
        await OCPPUtils.requestAndSaveChargingStationOcppParameters(
          tenant.id, chargingStation, chargingStationTemplateUpdated.ocppUpdated);
      }
    }
    if (updated > 0) {
      Logging.logDebug({
        tenantID: Constants.DEFAULT_TENANT,
        action: ServerAction.UPDATE_CHARGING_STATION_WITH_TEMPLATE,
        module: MODULE_NAME, method: 'updateChargingStationsWithTemplate',
        message: `${updated} Charging Stations have been updated with Template in Tenant '${tenant.name}'`
      });
    }
  }

  private async cleanUpChargingStationDBProps(tenant: Tenant) {
    const result = await global.database.getCollection<any>(tenant.id, 'chargingstations').updateMany(
      { },
      {
        $unset: {
          'numberOfConnectedPhase': '',
          'inactive': '',
          'cannotChargeInParallel': '',
          'currentType': '',
          'ocppAdvancedCommands': '',
        }
      },
      { upsert: false }
    );
    if (result.modifiedCount > 0) {
      Logging.logDebug({
        tenantID: Constants.DEFAULT_TENANT,
        action: ServerAction.UPDATE_CHARGING_STATION_WITH_TEMPLATE,
        module: MODULE_NAME, method: 'cleanUpChargingStationDBProps',
        message: `${result.modifiedCount} Charging Stations unused properties have been removed in Tenant '${tenant.name}'`
      });
    }
  }

  private async initChargingStationLimitAmps(tenant: Tenant) {
    let updated = 0;
    // Get the charging stations
    const chargingStations = await ChargingStationStorage.getChargingStations(tenant.id, {
      issuer: true
    }, Constants.DB_PARAMS_MAX_LIMIT);
    // Update
    for (const chargingStation of chargingStations.result) {
      // Check Charge Point
      if (chargingStation.chargePoints) {
        for (const chargePoint of chargingStation.chargePoints) {
          let chargePointUpdated = false;
          // Get the Vendor instance
          const chargingStationVendor = ChargingStationVendorFactory.getChargingStationVendorImpl(chargingStation);
          if (chargingStationVendor) {
            // Get max charge point amps
            const amperageChargePointMax = Utils.getChargingStationAmperage(chargingStation, chargePoint);
            try {
              // Call the limitation
              const result = await chargingStationVendor.setStaticPowerLimitation(tenant.id, chargingStation,
                chargePoint, amperageChargePointMax);
              if (result.status === OCPPConfigurationStatus.ACCEPTED || result.status === OCPPConfigurationStatus.REBOOT_REQUIRED) {
                chargePointUpdated = true;
                updated++;
              } else {
                Logging.logError({
                  tenantID: tenant.id,
                  action: ServerAction.UPDATE_CHARGING_STATION_WITH_TEMPLATE,
                  module: MODULE_NAME, method: 'initChargingStationLimitAmps',
                  message: `Cannot set Charge Point static limitation to ${amperageChargePointMax}A`,
                  detailedMessages: { chargePoint }
                });
              }
            } catch (error) {
              Logging.logError({
                tenantID: tenant.id,
                action: ServerAction.UPDATE_CHARGING_STATION_WITH_TEMPLATE,
                module: MODULE_NAME, method: 'initChargingStationLimitAmps',
                message: `Cannot set Charge Point static limitation to ${amperageChargePointMax}A`,
                detailedMessages: { error: error.message, stack: error.stack, chargePoint }
              });
            }
          }
          if (!chargePointUpdated) {
            // Update each connector manually
            for (const connectorID of chargePoint.connectorIDs) {
              // Get max connector amps
              const connector = Utils.getConnectorFromID(chargingStation, connectorID);
              if (connector) {
                const amperageConnectorMax = Utils.getChargingStationAmperage(chargingStation, chargePoint, connectorID);
                connector.amperageLimit = amperageConnectorMax;
              }
            }
            await ChargingStationStorage.saveChargingStation(tenant.id, chargingStation);
            updated++;
          }
        }
      } else if (chargingStation.connectors) {
        // Update each connector manually
        for (const connector of chargingStation.connectors) {
          if (connector) {
            connector.amperageLimit = connector.amperage;
          }
        }
        await ChargingStationStorage.saveChargingStation(tenant.id, chargingStation);
        updated++;
      }
    }
    if (updated > 0) {
      Logging.logDebug({
        tenantID: tenant.id,
        action: ServerAction.UPDATE_CHARGING_STATION_WITH_TEMPLATE,
        module: MODULE_NAME, method: 'cleanUpChargingStationDBProps',
        message: `${updated} Charging Stations amperage limit has been updated in Tenant '${tenant.name}'`
      });
    }
  }

  private async updateChargingStationTemplate() {
    // Update current Chargers
    ChargingStationStorage.updateChargingStationTemplatesFromFile().catch(
      (error) => {
        Logging.logActionExceptionMessage(Constants.DEFAULT_TENANT, ServerAction.UPDATE_CHARGING_STATION_TEMPLATES, error);
      });
  }
}
