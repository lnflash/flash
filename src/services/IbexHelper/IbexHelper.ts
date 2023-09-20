import axios, { AxiosError, AxiosRequestConfig } from "axios";

const IBexPluginBaseURL = "http://localhost:4800/api/v1";
// const IBexPluginBaseURL = "https://ibex-plugin-islandbitcoin.replit.app/api/v1";
const token = 'your-access-token-if-any';

const defaultHeaders: AxiosRequestConfig['headers'] = {
	// Authorization: token,
	'Content-Type': 'application/json',
};

export async function requestIBexPlugin(methodType: string, endpoint: string, params: object, body: object) {
	const result = {
		status: 400,
		data: null,
		error: "",
	};

	try {

		// let loginResponse = await axios.post("https://ibexhub.ibexmercado.com/auth/signin", { "email": "mail2michaelennis@gmail.com", "password": "Flash2023$" })
		// console.log("loginResponse", loginResponse)

		let response = { status: 200, data: null, error: "" };
		const requestOptions: AxiosRequestConfig = {
			headers: defaultHeaders,
		};

		if (methodType === 'GET') {
			response = await axios.get(`${IBexPluginBaseURL}${endpoint}`, requestOptions);
		} else if (methodType === 'PUT') {
			response = await axios.put(`${IBexPluginBaseURL}${endpoint}`, body, requestOptions);
		} else if (methodType === 'POST') {
			response = await axios.post(`${IBexPluginBaseURL}${endpoint}`, body, requestOptions);
		} else if (methodType === 'DELETE') {
			response = await axios.delete(`${IBexPluginBaseURL}${endpoint}`, requestOptions);
		}

		result.status = response.status;
		result.data = response.data;
	} catch (error) {
		console.log("error>>>", error);
		if (axios.isAxiosError(error)) {
			const axiosError = error as AxiosError;
			if (axiosError.response) {
				result.status = axiosError.response.status;
				result.error = axiosError.message;
			}
		}
	}

	console.log(result);
	return result;
}

// await requestIBexPlugin('GET', API_GetAccounts, {}, {});
// await requestIBexPlugin('GET', `${API_GetAccount}4b345a2c-093a-4b5a-b4ab-80313413859c`, {}, {});
// await requestIBexPlugin('POST', API_CreateAccount, {},
//     {
//         "name": "PurkeTest2",
//         "currencyId": 3
//     },);
// await requestIBexPlugin('POST', `${API_UpdateAccount}4b345a2c-093a-4b5a-b4ab-80313413859c`, {},
//     {
//         "name": "PurkeTest2"
//     });