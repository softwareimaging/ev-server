import ChargingStationClientFactory from '../../client/ocpp/ChargingStationClientFactory';
import ChargingStationStorage from '../../storage/mongodb/ChargingStationStorage';
import { CheckOfflineChargingStationsTaskConfig } from '../../types/TaskConfig';
import Constants from '../../utils/Constants';
import { LockEntity } from '../../types/Locking';
import LockingManager from '../../locking/LockingManager';
import Logging from '../../utils/Logging';
import NotificationHandler from '../../notification/NotificationHandler';
import SchedulerTask from '../SchedulerTask';
import { ServerAction } from '../../types/Server';
import Tenant from '../../types/Tenant';
import Utils from '../../utils/Utils';
import moment from 'moment';

export default class CheckOfflineChargingStationsTask extends SchedulerTask {

  async processTenant(tenant: Tenant, config: CheckOfflineChargingStationsTaskConfig): Promise<void> {
    // Get the lock
    const offlineChargingStationLock = LockingManager.createExclusiveLock(tenant.id, LockEntity.CHARGING_STATION, 'offline-charging-station');
    if (await LockingManager.acquire(offlineChargingStationLock)) {
      try {
        // Compute the date some minutes ago
        const offlineSince = moment().subtract(
          Utils.getChargingStationHeartbeatMaxIntervalSecs(), 'seconds').toDate();
        const chargingStations = await ChargingStationStorage.getChargingStations(tenant.id, {
          issuer: true,
          offlineSince
        }, Constants.DB_PARAMS_MAX_LIMIT);
        if (chargingStations.count > 0) {
          for (let i = 0; i < chargingStations.result.length; i++) {
            const chargingStationClient = await ChargingStationClientFactory.getChargingStationClient(tenant.id, chargingStations.result[i]);
            if ((await chargingStationClient.getConfiguration({})).configurationKey.length > 0) {
              // Update Heartbeat
              chargingStations.result[i].lastHeartBeat = new Date();
              // Save
              await ChargingStationStorage.saveChargingStation(tenant.id, chargingStations.result[i]);
              // Remove from notification
              chargingStations.result.splice(i);
            }
          }
          if (chargingStations.result.length > 0) {
            const chargingStationIDs: string = chargingStations.result.map((chargingStation) => chargingStation.id).join(', ');
            // Send notification
            await NotificationHandler.sendOfflineChargingStations(
              tenant.id, {
              chargeBoxIDs: chargingStationIDs,
              evseDashboardURL: Utils.buildEvseURL(tenant.subdomain)
            }
            );
          }
        }
      } catch (error) {
        // Log error
        Logging.logActionExceptionMessage(tenant.id, ServerAction.OFFLINE_CHARGING_STATION, error);
      } finally {
        // Release the lock
        await LockingManager.release(offlineChargingStationLock);
      }
    }
  }
}

