1|import {
     2|  CouldNotFindMerchantFromIdError,
     3|  CouldNotFindMerchantFromUsernameError,
     4|} from "@domain/errors"
     5|
     6|import { Merchant } from "./schema"
     7|import { caseInsensitiveRegex, parseRepositoryError } from "./utils"
     8|
     9|interface IMerchantRepository {
    10|  listForMap(): Promise<BusinessMapMarker[] | RepositoryError>
  findClosest(args: {
    latitude: number
    longitude: number
    limit: number
  }): Promise<BusinessMapMarker[] | RepositoryError>
    11|  listPendingApproval(): Promise<BusinessMapMarker[] | RepositoryError>
    12|  findById(id: MerchantId): Promise<BusinessMapMarker | RepositoryError>
    13|  findByUsername(username: Username): Promise<BusinessMapMarker[] | RepositoryError>
    14|  create(args: {
    15|    username: Username
    16|    coordinates: Coordinates
    17|    title: BusinessMapTitle
    18|    validated: boolean
    19|  }): Promise<BusinessMapMarker | RepositoryError>
    20|  update(args: {
    21|    id: MerchantId
    22|    coordinates: Coordinates
    23|    title: BusinessMapTitle
    24|    username: Username
    25|    validated: boolean
    26|  }): Promise<BusinessMapMarker | RepositoryError>
    27|  findOneAndUpdate(args: {
    28|    id: MerchantId
    29|    updates: Partial<{
    30|      coordinates: Coordinates
    31|      title: BusinessMapTitle
    32|      username: Username
    33|      validated: boolean
    34|    }>
    35|  }): Promise<BusinessMapMarker | RepositoryError>
    36|  remove(id: MerchantId): Promise<void | RepositoryError>
    37|}
    38|
    39|export const MerchantsRepository = (): IMerchantRepository => {
    40|  const findById = async (
    41|    id: MerchantId,
    42|  ): Promise<BusinessMapMarker | RepositoryError> => {
    43|    try {
    44|      const result = await Merchant.findOne({ id })
    45|      if (!result) {
    46|        return new CouldNotFindMerchantFromIdError(id)
    47|      }
    48|      return translateToMerchant(result)
    49|    } catch (err) {
    50|      return parseRepositoryError(err)
    51|    }
    52|  }
    53|
    54|  const findByUsername = async (
    55|    username: Username,
    56|  ): Promise<BusinessMapMarker[] | RepositoryError> => {
    57|    try {
    58|      const result = await Merchant.find({ username: caseInsensitiveRegex(username) })
    59|      if (result.length === 0) {
    60|        return new CouldNotFindMerchantFromUsernameError(username)
    61|      }
    62|      return result.map(translateToMerchant)
    63|    } catch (err) {
    64|      return parseRepositoryError(err)
    65|    }
    66|  }
    67|
    68|  const listForMap = async (): Promise<BusinessMapMarker[] | RepositoryError> => {
    69|    try {
    70|      const merchants = await Merchant.find({ validated: true })
    71|      return merchants.map(translateToMerchant)
    72|    } catch (err) {
    73|      return parseRepositoryError(err)
    74|    }
    75|  }
    76|
    77|  const listPendingApproval = async (): Promise<
    78|    BusinessMapMarker[] | RepositoryError
    79|  > => {
    80|    try {
    81|      const merchants = await Merchant.find({ validated: false })
    82|      return merchants.map(translateToMerchant)
    83|    } catch (err) {
    84|      return parseRepositoryError(err)
    85|    }
    86|  }
    87|
    88|  const create = async ({
    89|    username,
    90|    coordinates,
    91|    title,
    92|    validated,
    93|  }: {
    94|    username: Username
    95|    coordinates: Coordinates
    96|    title: BusinessMapTitle
    97|    validated: boolean
    98|  }): Promise<BusinessMapMarker | RepositoryError> => {
    99|    try {
   100|      const location = {
   101|        type: "Point",
   102|        coordinates: [coordinates.longitude, coordinates.latitude],
   103|      }
   104|
   105|      const result = await Merchant.create({ username, location, title, validated })
   106|
   107|      return translateToMerchant(result)
   108|    } catch (err) {
   109|      return parseRepositoryError(err)
   110|    }
   111|  }
   112|
   113|  const update = async ({
   114|    id,
   115|    coordinates,
   116|    title,
   117|    username,
   118|    validated,
   119|  }: {
   120|    id: MerchantId
   121|    coordinates: Coordinates
   122|    title: BusinessMapTitle
   123|    username: Username
   124|    validated: boolean
   125|  }) => {
   126|    const result = await Merchant.findOneAndUpdate(
   127|      { id },
   128|      { coordinates, title, username, validated },
   129|      { new: true },
   130|    )
   131|    if (!result) {
   132|      return new CouldNotFindMerchantFromIdError(id)
   133|    }
   134|
   135|    return translateToMerchant(result)
   136|  }
   137|
   138|  const findOneAndUpdate = async ({
   139|    id,
   140|    updates,
   141|  }: {
   142|    id: MerchantId
   143|    updates: Partial<{
   144|      coordinates: Coordinates
   145|      title: BusinessMapTitle
   146|      username: Username
   147|      validated: boolean
   148|    }>
   149|  }): Promise<BusinessMapMarker | RepositoryError> => {
   150|    try {
   151|      const result = await Merchant.findOneAndUpdate(
   152|        { id },
   153|        { $set: updates },
   154|        { new: true },
   155|      )
   156|      if (!result) {
   157|        return new CouldNotFindMerchantFromIdError(id)
   158|      }
   159|      return translateToMerchant(result)
   160|    } catch (err) {
   161|      return parseRepositoryError(err)
   162|    }
   163|  }
   164|
   165|  const remove = async (id: MerchantId): Promise<void | RepositoryError> => {
   166|    try {
   167|      const result = await Merchant.deleteOne({ id })
   168|      if (!result) {
   169|        return new CouldNotFindMerchantFromIdError(id)
  const findClosest = async ({
    latitude,
    longitude,
    limit,
  }: {
    latitude: number
    longitude: number
    limit: number
  }): Promise<BusinessMapMarker[] | RepositoryError> => {
    try {
      const merchants = await Merchant.find({
        validated: true,
        location: {
          $near: {
            $geometry: {
              type: "Point",
              coordinates: [longitude, latitude],
            },
          },
        },
      }).limit(limit)
      return merchants.map(translateToMerchant)
    } catch (err) {
      return parseRepositoryError(err)
    }
  }

  const translateToMerchant = (merchant: MerchantRecord): BusinessMapMarker => {
    const coordinatesTable = merchant.location.coordinates
    const coordinates: Coordinates = {
      longitude: coordinatesTable[0],
      latitude: coordinatesTable[1],
    }

    return {
      id: merchant.id as MerchantId,
      username: merchant.username as Username,
      title: merchant.title as BusinessMapTitle,
      coordinates,
      validated: merchant.validated,
      createdAt: merchant.createdAt,
    }
  }

  return {
    listForMap,
    listPendingApproval,
    findClosest,
    findById,
    findByUsername,
    create,
    update,
    findOneAndUpdate,
    remove,
  }
}
