import { apiResponse } from '../../shared/utils/response.util.js';
import { catchAsync } from '../../shared/utils/catchAsync.util.js';
import { COMPANY_NAME } from '../../config/secret.config.js';

export const healthController = {
  healthCheck: catchAsync(async (req, res) => {
    return apiResponse.success(res, {
      statusCode: 200,
      message: `${COMPANY_NAME} API is running`,
      data: {
        timestamp: new Date().toISOString(),
      },
    });
  }),
};
