import { findClosestDate } from 'components/MapView/DateSelector/utils';
import { checkLayerAvailableDatesAndContinueOrRemove } from 'components/MapView/utils';
import { appConfig } from 'config';
import { Extent } from 'components/MapView/Layers/raster-utils';
import { LayerKey, LayerType, isMainLayer, DateItem } from 'config/types';
import { LayerDefinitions, getBoundaryLayerSingleton } from 'config/utils';
import {
  addLayer,
  layerOrdering,
  removeLayer,
  updateDateRange,
} from 'context/mapStateSlice';
import {
  dateRangeSelector,
  layersSelector,
} from 'context/mapStateSlice/selectors';
import { addNotification } from 'context/notificationStateSlice';
import { availableDatesSelector } from 'context/serverStateSlice';
import { countBy, get, pickBy } from 'lodash';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { LocalError } from 'utils/error-utils';
import { DateFormat } from 'utils/name-utils';
import {
  DateCompatibleLayer,
  getPossibleDatesForLayer,
} from 'utils/server-utils';
import { UrlLayerKey, getUrlKey, useUrlHistory } from 'utils/url-utils';
import {
  datesAreEqualWithoutTime,
  binaryIncludes,
  getFormattedDate,
  getTimeInMilliseconds,
} from './date-utils';

const dateSupportLayerTypes: Array<LayerType['type']> = [
  'impact',
  'point_data',
  'wms',
  'static_raster',
];

const useLayers = () => {
  const dispatch = useDispatch();
  const [defaultLayerAttempted, setDefaultLayerAttempted] = useState(false);

  const { urlParams, updateHistory, removeLayerFromUrl } = useUrlHistory();
  const boundaryLayerId = getBoundaryLayerSingleton().id;

  const unsortedSelectedLayers = useSelector(layersSelector);
  const serverAvailableDates = useSelector(availableDatesSelector);
  const { startDate: selectedDate } = useSelector(dateRangeSelector);

  const hazardLayerIds = useMemo(() => {
    return urlParams.get(UrlLayerKey.HAZARD);
  }, [urlParams]);

  const hazardLayersArray = useMemo(() => {
    return hazardLayerIds !== null ? hazardLayerIds.split(',') : [];
  }, [hazardLayerIds]);

  const baselineLayerIds = useMemo(() => {
    return urlParams.get(UrlLayerKey.ADMINLEVEL);
  }, [urlParams]);

  const baselineLayersArray = useMemo(() => {
    return baselineLayerIds !== null ? baselineLayerIds.split(',') : [];
  }, [baselineLayerIds]);

  const numberOfActiveLayers = useMemo(() => {
    return hazardLayersArray.length + baselineLayersArray.length;
  }, [baselineLayersArray.length, hazardLayersArray.length]);

  // Prioritize boundary and point_data layers
  const selectedLayers: LayerType[] = useMemo(() => {
    // eslint-disable-next-line fp/no-mutating-methods
    return [...unsortedSelectedLayers].sort(layerOrdering);
  }, [unsortedSelectedLayers]);

  const adminBoundariesExtent = appConfig.map.boundingBox as Extent;

  const selectedLayersWithDateSupport = useMemo(() => {
    return selectedLayers
      .filter((layer): layer is DateCompatibleLayer => {
        if (
          layer.type === 'admin_level_data' ||
          layer.type === 'static_raster'
        ) {
          return Boolean(layer.dates);
        }
        if (layer.type === 'wms') {
          // some WMS layer might not have date dimension (i.e. static data)
          return layer.id in serverAvailableDates;
        }
        if (layer.type === 'composite') {
          // some WMS layer might not have date dimension (i.e. static data)
          return layer.dateLayer in serverAvailableDates;
        }
        return dateSupportLayerTypes.includes(layer.type);
      })
      .filter(layer => isMainLayer(layer.id, selectedLayers))
      .map(layer => {
        return {
          ...layer,
          dateItems: getPossibleDatesForLayer(layer, serverAvailableDates)
            .filter(value => value) // null check
            .flat(),
        };
      });
  }, [selectedLayers, serverAvailableDates]);

  /*
    takes all the dates possible for every layer and counts the amount of times each one is duplicated.
    if a date's duplicate amount is the same as the number of layers active, then this date is compatible with all layers selected.
  */
  const selectedLayerDatesDupCount = useMemo(() => {
    return countBy(
      selectedLayersWithDateSupport
        .map(layer => getPossibleDatesForLayer(layer, serverAvailableDates))
        .filter(value => value) // null check
        .flat()
        .map(value => new Date(value.displayDate).toISOString().slice(0, 10)),
    );
  }, [selectedLayersWithDateSupport, serverAvailableDates]);

  // calculate possible dates user can pick from the currently selected layers
  const selectedLayerDates: number[] = useMemo(() => {
    if (selectedLayersWithDateSupport.length === 0) {
      return [];
    }
    /*
      Only keep the dates which were duplicated the same amount of times as the amount of layers active...and convert back to array.
     */
    return Object.keys(
      pickBy(
        selectedLayerDatesDupCount,
        dupTimes => dupTimes >= selectedLayersWithDateSupport.length,
      ),
      // convert back to number array after using YYYY-MM-DD strings in countBy
    ).map(dateString => new Date(dateString).setUTCHours(12, 0, 0, 0));
  }, [selectedLayerDatesDupCount, selectedLayersWithDateSupport.length]);

  const defaultLayer = useMemo(() => {
    return get(appConfig, 'defaultLayer');
  }, []);

  const layerDefinitionsIncludeDefaultLayer = useMemo(() => {
    return Object.keys(LayerDefinitions).includes(defaultLayer);
  }, [defaultLayer]);

  const defaultLayerInLayerDefinitions = useMemo(() => {
    return LayerDefinitions[defaultLayer as LayerKey];
  }, [defaultLayer]);

  const selectedLayersIds = useMemo(() => {
    return selectedLayers.map(layer => layer.id);
  }, [selectedLayers]);

  const urlLayerIds = useMemo(() => {
    return [...hazardLayersArray, ...baselineLayersArray];
  }, [baselineLayersArray, hazardLayersArray]);

  const missingLayers = useMemo(() => {
    return urlLayerIds.filter(
      layerId => !selectedLayersIds.includes(layerId as LayerKey),
    );
  }, [selectedLayersIds, urlLayerIds]);

  useEffect(() => {
    /*
      This useEffect hook keeps track of parameters obtained from url and loads layers according
      to the hazardLayerId and baselineLayerId values. If the date field is found, the application
      status is also updated. There are guards in case the values are not valid, such as invalid
      date or layerids.
      */
    if (hazardLayerIds || baselineLayerIds) {
      return;
    }
    if (!defaultLayer) {
      return;
    }
    /*
      In case we don't have hazard or baseline layers we will use the default
      layer provided in the appConfig defined within `prism.json` file.
     */
    if (!defaultLayerAttempted && layerDefinitionsIncludeDefaultLayer) {
      setDefaultLayerAttempted(true);
      const urlLayerKey: UrlLayerKey = getUrlKey(
        defaultLayerInLayerDefinitions,
      );
      updateHistory(urlLayerKey, defaultLayer);
      return;
    }
    if (!defaultLayerAttempted) {
      dispatch(
        addNotification({
          message: `Invalid default layer identifier: ${defaultLayer}`,
          type: 'error',
        }),
      );
      setDefaultLayerAttempted(true);
    }
  }, [
    baselineLayerIds,
    defaultLayer,
    defaultLayerAttempted,
    defaultLayerInLayerDefinitions,
    dispatch,
    hazardLayerIds,
    layerDefinitionsIncludeDefaultLayer,
    updateHistory,
  ]);

  const serverAvailableDatesAreEmpty = useMemo(() => {
    return Object.keys(serverAvailableDates).length === 0;
  }, [serverAvailableDates]);

  const layerDefinitionIds = useMemo(() => {
    return Object.keys(LayerDefinitions);
  }, []);

  // Check for invalid layer ids.
  const invalidLayersIds = useMemo(() => {
    return urlLayerIds.filter(layerId => !layerDefinitionIds.includes(layerId));
  }, [layerDefinitionIds, urlLayerIds]);

  // Adds missing layers to existing map instance
  const addMissingLayers = useCallback((): void => {
    missingLayers.forEach(layerId => {
      const layer = LayerDefinitions[layerId as LayerKey];
      try {
        checkLayerAvailableDatesAndContinueOrRemove(
          layer,
          serverAvailableDates,
          removeLayerFromUrl,
          dispatch,
        );
      } catch (error) {
        console.error((error as LocalError).getErrorMessage());
        return;
      }
      dispatch(addLayer(layer));
    });
  }, [dispatch, missingLayers, removeLayerFromUrl, serverAvailableDates]);

  // let users know if their current date doesn't exist in possible dates
  const urlDate = useMemo(() => {
    return urlParams.get('date');
  }, [urlParams]);

  // The date integer from url
  const dateInt = useMemo(() => {
    return (urlDate ? new Date(urlDate) : new Date()).setUTCHours(12, 0, 0, 0);
  }, [urlDate]);

  useEffect(() => {
    if (
      (!hazardLayerIds && !baselineLayerIds) ||
      serverAvailableDatesAreEmpty
    ) {
      return;
    }

    // TODO - remove layers after dispatching the error message.
    if (invalidLayersIds.length > 0) {
      dispatch(
        addNotification({
          message: `Invalid layer identifier(s): ${invalidLayersIds.join(',')}`,
          type: 'error',
        }),
      );
      return;
    }

    // Add the missing layers
    addMissingLayers();

    if (!urlDate || dateInt === selectedDate) {
      return;
    }

    if (!Number.isNaN(dateInt)) {
      dispatch(updateDateRange({ startDate: dateInt }));
      updateHistory('date', getFormattedDate(dateInt, 'default') as string);
      return;
    }

    dispatch(
      addNotification({
        message: 'Invalid date found. Using most recent date',
        type: 'warning',
      }),
    );
  }, [
    addMissingLayers,
    baselineLayerIds,
    dateInt,
    dispatch,
    hazardLayerIds,
    invalidLayersIds,
    selectedDate,
    serverAvailableDatesAreEmpty,
    updateHistory,
    urlDate,
  ]);

  const removeLayerAndUpdateHistory = useCallback(
    (layerToRemove: LayerType, layerToKeep: LayerType) => {
      if (!selectedDate) {
        return;
      }
      // Remove layer from url.
      const urlLayerKey = getUrlKey(layerToRemove);
      removeLayerFromUrl(urlLayerKey, layerToRemove.id);
      dispatch(removeLayer(layerToRemove));

      const layerToKeepDates = getPossibleDatesForLayer(
        layerToKeep as DateCompatibleLayer,
        serverAvailableDates,
      ).map(dateItem => dateItem.displayDate);

      const closestDate = findClosestDate(selectedDate, layerToKeepDates);

      updateHistory(
        'date',
        getFormattedDate(closestDate, DateFormat.Default) as string,
      );
    },
    [
      dispatch,
      removeLayerFromUrl,
      selectedDate,
      serverAvailableDates,
      updateHistory,
    ],
  );

  // let users know if the layers selected are not possible to view together.
  useEffect(() => {
    if (
      selectedLayerDates.length !== 0 ||
      selectedLayersWithDateSupport.length === 0 ||
      !selectedDate
    ) {
      return;
    }

    // WARNING - This logic doesn't apply anymore if we order layers differently...
    const layerToRemove = selectedLayers[selectedLayers.length - 2];
    const layerToKeep = selectedLayers[selectedLayers.length - 1];

    dispatch(
      addNotification({
        message: `No dates overlap with the selected layers. Removing previous layer: ${layerToRemove.id}.`,
        type: 'warning',
      }),
    );
    removeLayerAndUpdateHistory(layerToRemove, layerToKeep);
  }, [
    dispatch,
    removeLayerAndUpdateHistory,
    selectedDate,
    selectedLayerDates.length,
    selectedLayers,
    selectedLayersWithDateSupport.length,
  ]);

  const possibleDatesForLayerIncludeSelectedDate = useCallback(
    (layer: DateCompatibleLayer, date: Date) => {
      return binaryIncludes<DateItem>(
        getPossibleDatesForLayer(layer, serverAvailableDates),
        date.setUTCHours(12, 0, 0, 0),
        x => new Date(x.displayDate).setUTCHours(12, 0, 0, 0),
      );
    },
    [serverAvailableDates],
  );

  useEffect(() => {
    if (
      !selectedDate ||
      !urlDate ||
      getTimeInMilliseconds(urlDate) === selectedDate
    ) {
      return;
    }
    selectedLayersWithDateSupport.forEach(layer => {
      const jsSelectedDate = new Date(selectedDate);

      if (
        serverAvailableDatesAreEmpty ||
        possibleDatesForLayerIncludeSelectedDate(layer, jsSelectedDate)
      ) {
        return;
      }

      const closestDate = findClosestDate(selectedDate, selectedLayerDates);

      if (
        datesAreEqualWithoutTime(
          jsSelectedDate.valueOf(),
          closestDate.valueOf(),
        )
      ) {
        console.warn({ closestDate });
        console.warn(
          'closest dates is the same as selected date, not updating url',
        );
      } else {
        updateHistory(
          'date',
          getFormattedDate(closestDate, DateFormat.Default) as string,
        );
      }

      dispatch(
        addNotification({
          message: `No data was found for layer '${
            layer.title
          }' on ${getFormattedDate(
            jsSelectedDate,
            DateFormat.Default,
          )}. The closest date ${getFormattedDate(
            closestDate,
            DateFormat.Default,
          )} has been loaded instead.`,
          type: 'warning',
        }),
      );
    });
  }, [
    dispatch,
    possibleDatesForLayerIncludeSelectedDate,
    selectedDate,
    selectedLayerDates,
    selectedLayersWithDateSupport,
    serverAvailableDatesAreEmpty,
    updateHistory,
    urlDate,
  ]);

  return {
    adminBoundariesExtent,
    boundaryLayerId,
    numberOfActiveLayers,
    selectedLayerDates,
    selectedLayers,
    selectedLayersWithDateSupport,
  };
};

export default useLayers;
