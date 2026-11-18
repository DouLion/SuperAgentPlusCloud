// 契约 Mock 路由（T13）：从 published api_contract 动态生成，只读开发辅助。

import { listArtifacts } from '../../db/artifacts.mjs';
import { mockFromContract } from '../../contracts/openapi.mjs';

export const ROUTES = [
  {
    method: '*', pattern: '/mock/:projectId/*rest',
    handler: ({ db, params, req }) => {
      const contracts = listArtifacts(db, {
        project_id: params.projectId,
        type: 'api_contract',
        status: 'published',
      });
      if (!contracts.length) {
        return { status: 404, body: { error: `项目没有已发布 API 契约：${params.projectId}`, code: 'MOCK_CONTRACT_NOT_FOUND' } };
      }
      // 最新创建/版本在前；第一个匹配真实 method/path 的契约获胜。
      let lastError;
      for (const contract of contracts) {
        try {
          const mock = mockFromContract(contract.content, req.method, `/${params.rest || ''}`);
          return {
            status: mock.status,
            body: mock.body,
            headers: {
              'x-sap-artifact-id': contract.artifact_id,
              'x-sap-operation-id': mock.operation_id || '',
            },
          };
        } catch (error) {
          if (error?.code !== 'MOCK_OPERATION_NOT_FOUND') throw error;
          lastError = error;
        }
      }
      throw lastError;
    },
  },
];
